"""Shared official PDF reader for bond input projections (persistent cache + Guard)."""
import hashlib
import json
import os
import sys
import tempfile
import unicodedata
import urllib.request
from importlib.metadata import version
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'ipo-report'))
from document_pdf_cache import get_cached_pdf, put_cached_pdf
from external_call_guard import guarded_urlopen
import fitz


def read_document(url, security_code=None, bond_name=None, issuer_name=None, ocr=False, stop_when=None):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in {
        'static.cninfo.com.cn', 'www.sse.com.cn', 'big5.sse.com.cn',
        'static.sse.com.cn', 'disc.static.szse.cn',
    }:
        raise ValueError('仅允许读取登记的交易所或巨潮官方 PDF')
    cached = get_cached_pdf(url)
    data = cached.read_bytes() if cached else None
    if data:
        try:
            with fitz.open(stream=data, filetype='pdf') as document:
                if not len(document):
                    data = None
        except Exception:
            data = None
    if data is None:
        request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        limit = int(os.environ.get('DOCUMENT_PDF_MAX_BYTES', str(128 * 1024 * 1024)))
        with guarded_urlopen(request, timeout=30, source=None, dataset=f'bond-document:{url}') as response:
            data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('PDF 文件超过已配置原文大小保护线，资料保持未完成')
        with fitz.open(stream=data, filetype='pdf') as document:
            if not len(document):
                raise ValueError('PDF 无有效页面')
        cached = put_cached_pdf(url, data)
    document_hash = hashlib.sha256(data).hexdigest()
    with fitz.open(stream=data, filetype='pdf') as document:
        pages = [page.get_text() for page in document]
        ocr_pages = []
        if ocr:
            checkpoint = cached.with_suffix('.ocr-v1.json')
            identity = {'document_hash': document_hash, 'method': 'rapidocr-onnx-v1',
                        'rapidocr': version('rapidocr-onnxruntime'), 'onnxruntime': version('onnxruntime'),
                        'scale': 2, 'min_confidence': 0.85}
            progress = {'identity': identity, 'pages': {}}
            try:
                saved = json.loads(checkpoint.read_text(encoding='utf-8'))
                if saved.get('identity') == identity and isinstance(saved.get('pages'), dict):
                    progress = saved
            except (OSError, ValueError, AttributeError):
                pass
            engine = None
            recognized = []
            for index, page in enumerate(document):
                key = str(index + 1)
                text = progress['pages'].get(key)
                if not isinstance(text, str):
                    if engine is None:
                        from rapidocr_onnxruntime import RapidOCR
                        import numpy as np
                        engine = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
                    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                    array = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
                    rows, _ = engine(array)
                    text = '\n'.join(row[1] for row in (rows or []) if float(row[2]) >= 0.85)
                    progress['pages'][key] = text
                    fd, temporary = tempfile.mkstemp(prefix='ocr-', suffix='.part', dir=str(cached.parent))
                    try:
                        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                            json.dump(progress, handle, ensure_ascii=False)
                        os.replace(temporary, checkpoint)
                    finally:
                        if os.path.exists(temporary):
                            os.remove(temporary)
                recognized.append(text)
                ocr_pages.append(index + 1)
                if stop_when and stop_when(recognized):
                    break
            pages = recognized
    compact = ''.join(unicodedata.normalize('NFKC', ''.join(pages)).split())
    if not compact:
        raise ValueError('PDF 无文本层，需要OCR，不能作为解析完成')
    issuer = ''.join(unicodedata.normalize('NFKC', issuer_name or '').split())
    if security_code and security_code.split('.')[0] not in compact and not (issuer and issuer in compact):
        raise ValueError('PDF 未匹配目标发行人证券代码')
    if bond_name and ''.join(bond_name.split()) not in compact:
        raise ValueError('PDF 未匹配目标可转债简称')
    return pages, {'source_url': url, 'document_hash': document_hash,
                   'security_code': security_code, 'bond_name': bond_name, 'issuer_name': issuer_name,
                   'text_method': 'rapidocr-onnx-v1' if ocr else 'pdf_text', 'ocr_pages': ocr_pages,
                   'ocr_min_confidence': 0.85 if ocr else None}
