"""Step 2+3: 添加供股权日期提取 + 中文日期辅助函数"""
filepath = 'server/scripts/extractArbitrageDocument.py'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

changes = 0

# === 2. 在 "if 'first_announcement' not in result['dates']:" 之后插入供股权日期提取 ===
marker = "if 'first_announcement' not in result['dates']:"
idx = content.find(marker)
if idx >= 0:
    # Find the end of this if block (next line at same or less indent that isn't empty)
    # Simple approach: find the next date-related line after this
    after = content.find('\n    # ', idx)  # next comment at indent level
    if after < 0:
        after = content.find('\n\n', idx)  # next blank line
    if after > 0:
        insert_pos = content.find('\n', after) + 1
        new_code = '''
    # 供股权专用日期（中文日期格式）
    _cn_dates = {}
    for dm in RE_CN_DATE.finditer(text):
        _ds = "20" + _cn_yy(dm.group(1)) + "-" + _cn_num(dm.group(2)) + "-" + _cn_num(dm.group(3))
        if "first_announcement" not in _cn_dates:
            _cn_dates["first_announcement"] = _ds
    if _cn_dates:
        result["dates"].update(_cn_dates)

    # 供股权交易期
    m_rp = RE_RIGHTS_TRADE_PERIOD.search(text)
    if m_rp:
        _rp_ctx = text[m_rp.start():m_rp.start()+200]
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
'''
        content = content[:insert_pos] + new_code + content[insert_pos:]
        changes += 1
        print(f'2. Added rights date extraction')
    else:
        print('2. ERROR: cannot find insertion point after marker')
else:
    print('2. ERROR: marker not found')

# === 3. 在 def parse_fields 之前添加辅助函数 ===
func_marker = 'def parse_fields('
idx = content.find(func_marker)
if idx >= 0:
    helpers = '''
def _cn_yy(s):
    return {"五":"25","六":"26","七":"27","八":"28","九":"29"}.get(s, s)

def _cn_num(s):
    m = {"零":0,"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10,
       "十一":11,"十二":12,"十三":13,"十四":14,"十五":15,"十六":16,"十七":17,"十八":18,"十九":19,
       "二十":20,"二十一":21,"二十二":22,"二十三":23,"二十四":24,"二十五":25,"二十六":26,
       "二十七":27,"二十八":28,"二十九":29,"三十":30}
    if s in m: return str(m[s])
    n = 0
    for ch in s:
        if ch in m and m[ch] < 10: n = n * 10 + m[ch]
        elif ch == "十": n = n * 10 if n > 0 else 10
    return str(n) if n > 0 else s

'''
    content = content[:idx] + helpers + content[idx:]
    changes += 1
    print(f'3. Added _cn_yy/_cn_num helpers')
else:
    print('3. ERROR: def parse_fields not found')

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print(f'Done - total {changes} modifications')
