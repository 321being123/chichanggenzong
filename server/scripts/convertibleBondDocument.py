"""Shared official PDF reader for bond input projections (persistent cache + Guard)."""
import hashlib
import os
import sys
import urllib.request
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'ipo-report'))
from document_pdf_cache import get_cached_pdf, put_cached_pdf
from external_call_guard import guarded_urlopen
import fitz


def read_document(url, security_code=None, bond_name=None, issuer_name=None):
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
        with guarded_urlopen(request, timeout=30, source=None, dataset=f'bond-document:{url}') as response:
            data = response.read(30 * 1024 * 1024 + 1)
        if len(data) > 30 * 1024 * 1024:
            raise ValueError('PDF 文件超过 30MB')
        with fitz.open(stream=data, filetype='pdf') as document:
            if not len(document):
                raise ValueError('PDF 无有效页面')
        put_cached_pdf(url, data)
    with fitz.open(stream=data, filetype='pdf') as document:
        pages = [page.get_text() for page in document]
    compact = ''.join(''.join(pages).split())
    if not compact:
        raise ValueError('PDF 无文本层，需要OCR，不能作为解析完成')
    if security_code and security_code.split('.')[0] not in compact and not (issuer_name and issuer_name in compact):
        raise ValueError('PDF 未匹配目标发行人证券代码')
    if bond_name and ''.join(bond_name.split()) not in compact:
        raise ValueError('PDF 未匹配目标可转债简称')
    return pages, {'source_url': url, 'document_hash': hashlib.sha256(data).hexdigest(),
                   'security_code': security_code, 'bond_name': bond_name, 'issuer_name': issuer_name}
