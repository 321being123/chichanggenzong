#!/usr/bin/env python
# -*- coding: utf-8 -*-
import sys, os, tempfile, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server.scripts.extractArbitrageDocument import extract_text_from_pdf, download_pdf
for code, url in {"601989":"https://static.cninfo.com.cn/finalpage/2025-09-04/1224636675.PDF","600150":"https://static.cninfo.com.cn/finalpage/2025-09-04/1224636691.PDF"}.items():
    t = tempfile.mktemp(suffix='.pdf'); ok,err = download_pdf(url,t)
    if not ok: print(code,"DL",err); continue
    text,err = extract_text_from_pdf(t); os.remove(t)
    print("==== ", code)
    for m in re.finditer(r'.{0,30}换股吸收合并.{0,30}', text):
        print("  SA:", m.group(0).replace('\n',' '))
    print("  --- swap price ctx ---")
    for m in re.finditer(r'.{0,25}换股价格.{0,12}', text):
        print("  SP:", m.group(0).replace('\n',' '))
