#!/usr/bin/env python
# -*- coding: utf-8 -*-
import sys, os, tempfile, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server.scripts.extractArbitrageDocument import extract_text_from_pdf, download_pdf, RE_ABSORB_STRUCTURE, RE_SWAP_PRICE, RE_SWAP_NAMED, _norm_name, _match_price

URLS = {
    "601989": "https://static.cninfo.com.cn/finalpage/2025-09-04/1224636675.PDF",
    "600150": "https://static.cninfo.com.cn/finalpage/2025-09-04/1224636691.PDF",
}
for code, url in URLS.items():
    t = tempfile.mktemp(suffix='.pdf')
    ok, err = download_pdf(url, t)
    if not ok: print(code, "DL fail", err); continue
    text, err = extract_text_from_pdf(t); os.remove(t)
    if err: print(code, "PDF fail", err); continue
    print("==== ", code, " len", len(text))
    ms = list(RE_ABSORB_STRUCTURE.finditer(text))
    print("STRUCT matches:", [(m.group(1), m.group(2)) for m in ms][:3])
    sp = {}
    for m in RE_SWAP_PRICE.finditer(text):
        sp[_norm_name(m.group(1))] = m.group(2)
    print("SWAP_PRICES:", sp)
    print("NAMED matches:")
    for m in RE_SWAP_NAMED.finditer(text):
        print("   ", m.group(1), _norm_name(m.group(2)), m.group(3), _norm_name(m.group(4)))
