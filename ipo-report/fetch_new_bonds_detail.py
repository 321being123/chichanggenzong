#!/usr/bin/env python3
"""
逐个访问集思录详情页，用getElementById精准提取限售规模等字段
用subprocess list传参避免shell引号问题
"""
import sys, io, time, json, re, subprocess, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

NEW_BONDS = [
    ("123271","通合科技","2026-06-17",5.22),
    ("123270","盛德鑫泰","2026-06-12",4.05),
    ("123267","珂玛科技","2026-05-13",7.5),
    ("123269","金杨精密","2026-05-11",9.8),
    ("113702","斯达半导","2026-05-11",15.0),
    ("123268","本川智能","2026-05-07",4.69),
    ("118067","上声电子","2026-04-14",3.25),
    ("123266","博士眼镜","2026-04-07",3.75),
    ("127113","长高电气","2026-03-30",7.59),
    ("113701","祥和实业","2026-03-26",4.0),
    ("118066","统联精密","2026-03-20",5.76),
    ("113700","海天股份","2026-03-12",8.01),
    ("118065","艾为电子","2026-02-26",19.01),
    ("110100","龙建股份","2026-02-12",10.0),
    ("127112","尚太科技","2026-02-05",17.34),
    ("123265","耐普矿机","2026-01-30",4.5),
    ("118064","联瑞新材","2026-01-28",6.95),
    ("111024","澳弘电子","2026-01-16",5.8),
    ("123264","双乐股份","2026-01-16",8.0),
    ("118063","金盘科技","2026-01-14",16.72),
    ("123263","鼎捷数智","2025-12-31",8.28),
    ("118062","天准科技","2025-12-31",8.72),
    ("123262","神宇股份","2025-12-30",5.0),
    ("123261","普联软件","2025-12-22",2.43),
]

CHROME = r"C:\Users\戴存在\AppData\Local\Google\Chrome\Application\chrome.exe"
AB_CMD = r"C:\ProgramData\WorkBuddy\chromium-env\6mxrd7\.workbuddy\binaries\node\versions\22.22.2\agent-browser.cmd"

def run_ab(args):
    """用list传参，避免shell引号问题"""
    r = subprocess.run([AB_CMD] + args, capture_output=True, text=True, timeout=60)
    return r.stdout.strip()

def login():
    """登录集思录"""
    print("登录集思录...", end=" ", flush=True)
    run_ab(['open', '--executable-path', CHROME, 'https://www.jisilu.cn/account/login/'])
    time.sleep(3)
    run_ab(['wait', '--load', 'networkidle'])
    time.sleep(1)
    
    # 获取交互元素
    snap = run_ab(['snapshot', '-i'])
    # 找checkbox和输入框的ref
    lines = snap.split('\n')
    checkbox_ref = None
    user_ref = None
    pass_ref = None
    btn_ref = None
    for line in lines:
        if 'checkbox' in line and 'checked=false' in line and 'e21' in line:
            checkbox_ref = 'e21'
        if 'textbox' in line and 'e15' in line:
            user_ref = 'e15'
        if 'textbox' in line and 'e16' in line:
            pass_ref = 'e16'
        if 'button' in line and 'e25' in line:
            btn_ref = 'e25'
    
    # 默认用上次的ref（页面结构稳定）
    run_ab(['click', 'e21'])  # 勾选协议
    run_ab(['type', 'e15', '18612596191'])
    run_ab(['type', 'e16', os.environ.get("JISILU_PASS", "")])
    run_ab(['click', 'e25'])  # 登录
    time.sleep(5)
    run_ab(['wait', '--load', 'networkidle'])
    time.sleep(2)
    print("完成")

def fetch_detail(code):
    """访问详情页，提取字段"""
    url = f'https://www.jisilu.cn/data/convert_bond_detail/{code}'
    run_ab(['open', url])
    time.sleep(3)
    run_ab(['wait', '--load', 'networkidle'])
    time.sleep(1)
    
    # 逐个字段提取，每个用简单JS避免引号问题
    d = {}
    
    # 发行规模
    out = run_ab(['eval', "var el=document.getElementById('orig_iss_amt');el?el.innerText.trim():''"])
    if out and out != '""': 
        try: d['issue'] = float(out.strip('"'))
        except: pass
    
    # 限售规模
    out = run_ab(['eval', "var el=document.getElementById('lck_iss_amt');el?el.innerText.trim():''"])
    if out and out != '""':
        try: d['lock'] = float(out.strip('"'))
        except: pass
    
    # 剩余规模
    out = run_ab(['eval', "var el=document.getElementById('curr_iss_amt');el?el.innerText.trim():''"])
    if out and out != '""':
        try: d['remain'] = float(out.strip('"'))
        except: pass
    
    # 溢价率
    out = run_ab(['eval', "var el=document.getElementById('premium_rt');el?el.innerText.trim():''"])
    if out and out != '""':
        try: 
            v = out.strip('"').replace('%','').strip()
            d['premium'] = float(v)
        except: pass
    
    # 转股价值
    out = run_ab(['eval', "var el=document.getElementById('convert_value');el?el.innerText.trim():''"])
    if out and out != '""':
        try: d['tv'] = float(out.strip('"'))
        except: pass
    
    # 价格
    out = run_ab(['eval', "var el=document.getElementById('bond_price');el?el.innerText.trim():''"])
    if out and out != '""':
        try: d['price'] = float(out.strip('"'))
        except: pass
    
    # 股东配售率 — 需要遍历td.jisilu_title找
    out = run_ab(['eval', "var els=document.querySelectorAll('td.jisilu_title');for(var i=0;i<els.length;i++){if(els[i].innerText.indexOf('股东配售率')>=0){var n=els[i].nextElementSibling;if(n)return n.innerText.trim()}}return''"])
    if out and out != '""':
        m = re.search(r'([\d.]+)', out)
        if m:
            try: d['placement'] = float(m.group(1))
            except: pass
    
    # 上市日
    out = run_ab(['eval', "var el=document.getElementById('listing_date');el?el.innerText.trim():''"])
    if out and out != '""':
        d['listing_date'] = out.strip('"').strip()
    
    # 评级
    out = run_ab(['eval', "var els=document.querySelectorAll('td.jisilu_title');for(var i=0;i<els.length;i++){if(els[i].innerText.indexOf('主体评级')>=0){var n=els[i].nextElementSibling;if(n)return n.innerText.trim()}}return''"])
    if out and out != '""':
        d['rating'] = out.strip('"').strip()
    
    return d

# 主流程
login()

results = []
for i, (code, name, ld, issue) in enumerate(NEW_BONDS):
    print(f"[{i+1}/{len(NEW_BONDS)}] {code} {name}...", end=" ", flush=True)
    
    d = fetch_detail(code)
    d['code'] = code
    d['name'] = name
    
    # 计算流通规模
    if d.get('issue') and d.get('lock') is not None:
        d['circulation'] = round(d['issue'] - d['lock'], 4)
    elif d.get('issue') and d.get('placement'):
        d['circulation'] = round(d['issue'] * (1 - d['placement']/100), 4)
        d['lock'] = round(d['issue'] - d['circulation'], 4)
    
    print(f"发行={d.get('issue','?')} 限售={d.get('lock','?')} 流通={d.get('circulation','?')} "
          f"配售率={d.get('placement','?')}% TV={d.get('tv','?')} 溢价={d.get('premium','?')}%")
    
    results.append(d)
    time.sleep(0.3)

# 保存
with open(r"D:\Users\日报\new_bonds_detail.json", 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print(f"\n保存到 new_bonds_detail.json")

# 统计
print("\n" + "="*70)
print("按流通规模分档统计")
print("="*70)

valid = [r for r in results if r.get('circulation') is not None and r.get('premium') is not None]
print(f"有效数据: {len(valid)}/{len(results)} 只\n")

def stats(label, items):
    if not items:
        print(f"  {label}（0只）: 无数据")
        return
    premiums = [float(d['premium']) for d in items]
    avg = sum(premiums) / len(premiums)
    med = sorted(premiums)[len(premiums)//2]
    print(f"  {label}（{len(items)}只）: 平均={avg:.1f}% 中位={med:.1f}% [min={min(premiums):.1f}% max={max(premiums):.1f}%]")

for lo, hi in [(0,1), (1,1.5), (1.5,2), (2,3), (3,5), (5,10), (10,999)]:
    items = [d for d in valid if lo <= d['circulation'] < hi]
    stats(f"流通 {lo}-{hi}亿", items)

# 明细
print("\n" + "="*70)
print("明细（按流通规模排序）")
print("="*70)
for d in sorted(valid, key=lambda x: x['circulation']):
    print(f"  {d['code']} {d['name']:8s}  发行={d.get('issue',0):.2f}  "
          f"限售={d.get('lock',0):.2f}  流通={d['circulation']:.2f}  "
          f"配售率={d.get('placement',0):.1f}%  "
          f"TV={d.get('tv',0):.2f}  溢价={d.get('premium',0):.1f}%  "
          f"评级={d.get('rating','?')}")

# 对比：用发行规模分档
print("\n" + "="*70)
print("对比：用发行规模分档（旧方法）")
print("="*70)
for lo, hi in [(0,3), (3,5), (5,10), (10,20)]:
    items = [d for d in valid if lo <= d.get('issue', 0) < hi]
    stats(f"发行 {lo}-{hi}亿", items)

run_ab(['close'])
