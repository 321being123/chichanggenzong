#!/usr/bin/env python
# -*- coding: utf-8 -*-
import sys, re, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server.scripts.extractArbitrageDocument import extract_text_from_pdf, download_pdf
import tempfile

url = sys.argv[1]
t = tempfile.mktemp(suffix='.pdf')
ok, err = download_pdf(url, t)
if not ok:
    print('download failed', err); sys.exit(1)
text, err = extract_text_from_pdf(t)
os.remove(t)
if err:
    print('extract failed', err); sys.exit(1)

print('len=', len(text), ' 含吸收合并=', '吸收合并' in text)
for code in ['601989', '600150']:
    hits = list(re.finditer(code, text))
    print(f'=== {code} 出现 {len(hits)} 次，前3处上下文 ===')
    for m in hits[:3]:
        s = max(0, m.start()-45); e = min(len(text), m.end()+25)
        print('   ...', text[s:e].replace('\n',' '), '...')
print('=== 换股比例/股...换...股 命中 ===')
for m in re.finditer(r'.{0,20}(?:换股比例|每\s*\d[^股]{0,20}股[^换]{0,20}换[^股]{0,20}股).{0,20}', text):
    print('   ', m.group(0).replace('\n',' '))
print('=== 换股价格 命中 ===')
for m in re.finditer(r'(?:换股价格|收购请求权价格)[^元]{0,20}?([\d.]+)\s*元', text):
    s = max(0, m.start()-30); e = min(len(text), m.end()+5)
    print('   ', text[s:e].replace('\n',' '))
