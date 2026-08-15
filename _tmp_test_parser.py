#!/usr/bin/env python
# -*- coding: utf-8 -*-
import sys, os, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server.scripts.extractArbitrageDocument import extract_text_from_pdf, download_pdf, parse_fields

# (label, url, target_code)
TESTS = [
    ("中国重工-提示性公告(601989)", "https://static.cninfo.com.cn/finalpage/2025-09-04/1224636675.PDF", "601989"),
    ("中国船舶-换股实施公告(600150)", "https://static.cninfo.com.cn/finalpage/2025-09-04/1224636691.PDF", "600150"),
    ("湘财-报告书(600095)", "https://static.cninfo.com.cn/finalpage/2025-09-26/1224683289.PDF", "600095"),
    ("大智慧-报告书摘要(601519)", "https://static.cninfo.com.cn/finalpage/2025-09-26/1224683294.PDF", "601519"),
]

for label, url, tc in TESTS:
    t = tempfile.mktemp(suffix='.pdf')
    ok, err = download_pdf(url, t)
    if not ok:
        print(f"[FAIL DL] {label}: {err}"); continue
    text, err = extract_text_from_pdf(t)
    os.remove(t)
    if err:
        print(f"[FAIL PDF] {label}: {err}"); continue
    # 测试无 target_code 与带 target_code 两种
    for use_tc in (None, tc):
        r = parse_fields(text, target_code=use_tc)
        sr = r.get('swap_ratio')
        rc = r.get('reference_codes')
        rn = r.get('reference_names')
        ev = [e for e in r.get('evidence', []) if e.get('field') == 'swap_ratio']
        evs = ';'.join(e.get('value', '') for e in ev)
        print(f"[{label}] tc={use_tc} swap_ratio={sr} ref_codes={rc} ref_names={rn} ev=[{evs}]")
    print('---')
