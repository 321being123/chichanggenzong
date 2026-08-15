# -*- coding: utf-8 -*-
filepath = 'server/scripts/extractArbitrageDocument.py'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# ---- 1. 替换交易期 + 付款截止提取逻辑 ----
old_block = """    # 供股权交易期
    m_rp = RE_RIGHTS_TRADE_PERIOD.search(text)
    if m_rp:
        _rp_ctx = text[max(0,m_rp.start()-100):m_rp.start()+200]
        _rp_dates = list(RE_CN_DATE.finditer(_rp_ctx))
        if len(_rp_dates) >= 2:
            d0, d1 = _rp_dates[0], _rp_dates[1]
            result["rights_trade_start"] = "20" + _cn_yy(d0.group(1)) + "-" + _cn_num(d0.group(2)) + "-" + _cn_num(d0.group(3))
            result["rights_trade_end"] = "20" + _cn_yy(d1.group(1)) + "-" + _cn_num(d1.group(2)) + "-" + _cn_num(d1.group(3))

    # 付款截止（最後接納時限）
    m_dl = RE_RIGHTS_DEADLINE.search(text)
    if m_dl:
        _dl_dates = list(RE_CN_DATE.finditer(m_dl.group()))
        if _dl_dates:
            d = _dl_dates[0]
            result["payment_deadline"] = "20" + _cn_yy(d.group(1)) + "-" + _cn_num(d.group(2)) + "-" + _cn_num(d.group(3))
"""

new_block = """    # 供股权交易期 / 付款截止 —— 稳健提取（支持中文数字年/数字年/缺年）
    _doc_year = _infer_doc_year(text)

    # 交易期：上午九時正 ... 下午四時正 期間 附近的成对日期
    m_rp = RE_RIGHTS_TRADE_PERIOD.search(text)
    if m_rp:
        _rp_ctx = text[max(0,m_rp.start()-120):m_rp.start()+200]
        _d0 = _extract_first_date(_rp_ctx, _doc_year)
        if _d0:
            _idx = _rp_ctx.find(_d0)
            _d1 = _extract_first_date(_rp_ctx[_idx+len(_d0):], _doc_year)
            if _d1:
                result["rights_trade_start"] = _d0
                result["rights_trade_end"] = _d1

    # 付款截止
    _dl = _find_rights_deadline(text, _doc_year)
    if _dl:
        result["payment_deadline"] = _dl
"""

if old_block in content:
    content = content.replace(old_block, new_block)
    print('OK: replaced extraction block')
else:
    print('WARN: extraction block NOT found')

# ---- 2. 在 def main(): 前插入辅助函数 ----
helpers = '''

def _infer_doc_year(text):
    """从公告文本推断年份，用于补「缺年」的日期（如「十月二十七日」补成 2025-10-27）"""
    m = re.search(r'二零二([五六七八九])年', text)
    if m:
        return "20" + _cn_yy(m.group(1))
    m = re.search(r'(20[0-9]{2})\\s*年', text)
    if m:
        return m.group(1)
    return None


def _extract_first_date(seg, doc_year=None):
    """在片段中找第一个日期，支持：数字年 / 中文数字年 / 缺年(用 doc_year 补)"""
    # 1) 数字年：2025年9月17日
    m = re.search(r'(20[0-9]{2})\\s*年\\s*([0-9]{1,2})\\s*月\\s*([0-9]{1,2})\\s*日', seg)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    # 2) 中文数字年：二零二五年九月十七日
    m = re.search(r'二零二([五六七八九])年([一二三四五六七八九十]{1,2})月([一二三四五六七八九十]{1,2})日', seg)
    if m:
        return "20" + _cn_yy(m.group(1)) + "-" + _cn_num(m.group(2)) + "-" + _cn_num(m.group(3))
    # 3) 缺年（仅月日）：九月十七日 -> 用 doc_year 补
    if doc_year:
        m = re.search(r'([一二三四五六七八九十]{1,2})月([一二三四五六七八九十]{1,2})日', seg)
        if m:
            return doc_year + "-" + _cn_num(m.group(1)) + "-" + _cn_num(m.group(2))
    return None


def _find_rights_deadline(text, doc_year=None):
    """寻找供股权付款截止日期。优先明确的「最後接納」系列关键词，再退到通用「截止」。"""
    explicit_kw = [
        r'最後接納時限', r'最後接納時間',
        r'繳付股款之截止時間', r'繳付股款.*截止',
        r'接納.*繳款.*最後', r'接納供股股份並繳付股款之截止時間',
    ]
    generic_kw = [r'截止時間', r'截止日期', r'最後時限', r'遞交.*最後時限', r'繳款之最後']
    for kw in explicit_kw + generic_kw:
        for m in re.finditer(kw, text):
            _seg = text[max(0, m.start()-150):m.end()+150]
            _d = _extract_first_date(_seg, doc_year)
            if _d:
                return _d
    return None


'''

marker = 'def main():'
if marker in content:
    content = content.replace(marker, helpers + marker, 1)
    print('OK: inserted helper functions before main()')
else:
    print('WARN: def main(): not found')

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
