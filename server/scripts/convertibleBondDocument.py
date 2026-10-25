"""Shared official PDF reader for bond input projections (persistent cache + Guard)."""
import hashlib
import json
import os
import re
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


def read_document(url, security_code=None, bond_name=None, issuer_name=None, ocr=False, stop_when=None, ocr_page_numbers=None):
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
                if ocr_page_numbers is not None and index + 1 not in ocr_page_numbers:
                    recognized.append(pages[index])
                    continue
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
    # 发行人可能更名或全称带/不带“集团”，正文仍须出现同一法人主体；
    # 只放宽带后缀的写法，核心名不足4字时不参与匹配，避免泛化到其他主体。
    issuer_forms = {form for form in {issuer, re.sub(r'(?:集团)?(?:股份有限公司|有限责任公司|有限公司)$', '', issuer)} if len(form) >= 4}
    if security_code and security_code.split('.')[0] not in compact and not any(form in compact for form in issuer_forms):
        raise ValueError('PDF 未匹配目标发行人证券代码')
    if bond_name and ''.join(bond_name.split()) not in compact:
        raise ValueError('PDF 未匹配目标可转债简称')
    return pages, {'source_url': url, 'document_hash': document_hash,
                   'security_code': security_code, 'bond_name': bond_name, 'issuer_name': issuer_name,
                   'text_method': 'rapidocr-onnx-v1' if ocr else 'pdf_text', 'ocr_pages': ocr_pages,
                   'ocr_min_confidence': 0.85 if ocr else None}


def bond_section_range(pages):
    compact = re.sub(r'\s+', '', ''.join(pages))
    matches = set(re.findall(r'第七节债券相关情况\D*(\d{1,4})\D*第八节财务报告\D*(\d{1,4})', compact))
    if len(matches) != 1:
        return None
    start, end = map(int, next(iter(matches)))
    return (start, end) if 0 < start < end else None


def read_report_document(url, security_code=None, bond_name=None, issuer_name=None):
    try:
        return read_document(url, security_code, bond_name, issuer_name)
    except ValueError as error:
        if '无文本层' not in str(error):
            raise
    # 先由本文件已有OCR与持久化检查点读取目录，不把试读当债项身份验证。
    preview, _ = read_document(url, security_code, None, issuer_name, ocr=True,
                               stop_when=lambda pages: bond_section_range(pages) is not None)
    section = bond_section_range(preview)
    if not section:
        raise ValueError('扫描报告缺少可唯一核验的债券章节目录页码')
    start, end = section
    with fitz.open(get_cached_pdf(url)) as document:
        if end > len(document) + 1:
            raise ValueError('扫描报告目录页码超出原文范围')
    selected = set(range(1, len(preview) + 1)) | set(range(start, end))
    pages, evidence = read_document(url, security_code, bond_name, issuer_name, ocr=True,
                                    ocr_page_numbers=selected)
    if '债券相关情况' not in re.sub(r'\s+', '', ''.join(pages[start-1:end-1])):
        raise ValueError('扫描报告实际页与目录债券章节不匹配')
    return pages, {**evidence, 'ocr_scope': 'toc_bond_section', 'ocr_section_pages': [start, end-1]}


def report_table_rows(url, evidence):
    """仅为已核验扫描报告恢复有完整网格的单元格，保留原文与独立缓存。"""
    if evidence.get('text_method') != 'rapidocr-onnx-v1':
        return []
    cached = get_cached_pdf(url)
    if not cached or hashlib.sha256(cached.read_bytes()).hexdigest() != evidence.get('document_hash'):
        raise ValueError('扫描表格原文与已核验哈希不一致')
    checkpoint = cached.with_suffix('.ocr-v1.json')
    identity = {'hash': evidence['document_hash'], 'rapidocr': version('rapidocr-onnxruntime'),
                'onnxruntime': version('onnxruntime'), 'version': 1}
    try:
        saved = json.loads(checkpoint.read_text(encoding='utf-8'))
        if saved.get('table_identity') == identity:
            return saved['table_rows']
    except (OSError, ValueError, KeyError):
        pass
    import cv2
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
    start, end = evidence['ocr_section_pages']
    output = []
    with fitz.open(cached) as document:
        for number in range(start, end + 1):
            pix = document[number-1].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            array = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            binary = cv2.threshold(cv2.cvtColor(array, cv2.COLOR_RGB2GRAY), 180, 255, cv2.THRESH_BINARY_INV)[1]
            def lines(kernel):
                mask = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, kernel))
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                return [cv2.boundingRect(contour) for contour in contours]
            horizontal = sorted((box for box in lines((100, 1)) if box[2] > pix.width * .65), key=lambda box: box[1])
            vertical = lines((1, 20))
            recognized, _ = engine(array)
            tokens = [(sum(p[0] for p in box)/4, sum(p[1] for p in box)/4, text)
                      for box, text, confidence in (recognized or []) if float(confidence) >= .85]
            for upper, lower in zip(horizontal, horizontal[1:]):
                top, bottom = upper[1], lower[1]
                if bottom-top < 20 or abs(upper[0]-lower[0]) > 3 or abs(upper[2]-lower[2]) > 3:
                    continue
                xs = sorted(set(x for x, y, w, h in vertical if y <= top+3 and y+h >= bottom-3
                                and upper[0]-3 <= x <= upper[0]+upper[2]+3))
                if len(xs) != 7 or abs(xs[0]-upper[0]) > 3 or abs(xs[-1]-(upper[0]+upper[2])) > 3:
                    continue
                cells = [''.join(text for x, y, text in sorted(tokens, key=lambda row: (row[1], row[0]))
                                 if left < x < right and top < y < bottom)
                         for left, right in zip(xs, xs[1:])]
                output.append({'page': number, 'top': top, 'cells': cells})
    fd, temporary = tempfile.mkstemp(prefix='table-ocr-', suffix='.part', dir=str(cached.parent))
    try:
        try:
            progress = json.loads(checkpoint.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            progress = {}
        progress.update(table_identity=identity, table_rows=output)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(progress, handle, ensure_ascii=False)
        os.replace(temporary, checkpoint)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return output
