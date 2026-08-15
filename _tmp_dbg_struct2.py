#!/usr/bin/env python
# -*- coding: utf-8 -*-
import sys, os, tempfile, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server.scripts.extractArbitrageDocument import extract_text_from_pdf, download_pdf, RE_ABSORB_STRUCTURE, RE_ABSORB_STRUCTURE2, RE_SWAP_PRICE, _norm_name
URLS = {"601989":"https://static.cninfo.com.cn/finalpage/2025-09-04/1224636675.PDF","600150":"https://static.cninfo.com.cn/finalpage/2025-09-04/1224636691.PDF"}
for code, url in URLS.items():
    t = tempfile.mktemp(suffix='.pdf'); ok,err = download_pdf(url,t)
    if not ok: print(code,"DL",err); continue
    text,err = extract_text_from_pdf(t); os.remove(t)
    print("==== ", code, "len", len(text))
    m = RE_ABSORB_STRUCTURE.search(text)
    print("STRUCT strict:", (m.group(1), m.group(2)) if m else None)
    m2 = RE_ABSORB_STRUCTURE2.search(text)
    print("STRUCT loose :", (m2.group(1), m2.group(2)) if m2 else None)
    # print 50 chars after each 换股吸收合并
    print("  after 换股吸收合并:")
    for mm in re.finditer(r'换股吸收合并.{0,40}', text):
        print("    >>", mm.group(0).replace('\n',' '))
    print("  swap prices:")
    sp={}
    for sm in RE_SWAP_PRICE.finditer(text):
        raw=sm.group(1); nm=_norm_name(raw.split('的')[-1].split('后')[-1])
        sp[nm]=sm.group(2)
    print("   ", sp)
