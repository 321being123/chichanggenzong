# -*- coding: utf-8 -*-
"""导入券商持仓数据到持仓管理系统（PostgreSQL版）

用法:
  python import_positions.py <A股文件> <港股文件> [--user=用户名]

示例:
  python import_positions.py table.xls tab1le.xls
  python import_positions.py table.xls tab1le.xls --user=daicunzai

数据库连接走环境变量（与 server/db.js 一致）：
  # 方式A：完整连接串（优先）
  DATABASE_URL=postgres://postgres:密码@localhost:5432/portfolio
  # 方式B：分项变量
  PGHOST=localhost PGHOST=... PGPORT=5432 PGUSER=postgres PGPASSWORD= PGPASSWORD= PGDATABASE=portfolio

解析逻辑（A股/港股/可转债分类、code.zfill(5) 港股前导0）与原 SQLite 版完全一致，仅数据库读写层换成 psycopg2。
"""

import json
import os
import sys
import csv
import time

# 默认用户名（可通过 --user=xxx 覆盖）
DEFAULT_USER = 'daicunzai'

# 默认路径（可通过命令行参数覆盖）
DEFAULT_A_FILE = os.path.expanduser('~/Desktop/table.xls')
DEFAULT_HK_FILE = os.path.expanduser('~/Desktop/tab1le.xls')

# 解析命令行参数
FILE1 = DEFAULT_A_FILE
FILE2 = DEFAULT_HK_FILE
USER = DEFAULT_USER
for arg in sys.argv[1:]:
    if arg.startswith('--user='):
        USER = arg.split('=', 1)[1]
    elif arg.startswith('--'):
        pass
    elif FILE1 == DEFAULT_A_FILE:
        FILE1 = arg
    elif FILE2 == DEFAULT_HK_FILE:
        FILE2 = arg

def get_conn():
    """PostgreSQL 连接：优先 DATABASE_URL，否则用 PG* 环境变量（与 server/db.js 一致）。"""
    url = os.environ.get('DATABASE_URL')
    if url:
        import psycopg2
        return psycopg2.connect(url)
    import psycopg2
    return psycopg2.connect(
        host=os.environ.get('PGHOST', 'localhost'),
        port=os.environ.get('PGPORT', '5432'),
        user=os.environ.get('PGUSER', 'postgres'),
        password=os.environ.get('PGPASSWORD', ''),
        dbname=os.environ.get('PGDATABASE', 'portfolio'),
    )

def uid():
    return format(int(time.time() * 1000), 'x') + format(int.from_bytes(os.urandom(4), 'big'), 'x')

def classify(code):
    """根据证券代码判断类型，匹配前端 recognizeCode 逻辑"""
    clean = code.strip().upper()
    if not clean:
        return ('股权', 'A股')
    num = clean.replace('.SH','').replace('.SZ','').replace('.HK','').replace('.US','')
    num = num.replace('SH','').replace('SZ','').replace('HK','').replace('US','')
    if not num.isdigit():
        return ('股权', '美股')
    if len(num) <= 5:
        return ('股权', '港股')  # 港股通标的
    first3 = num[:3]
    first2 = num[:2]
    first1 = num[:1]
    if first3 in ('123','127') or first2 in ('11','12'):
        return ('债权', '可转债')
    if first2 == '13':
        return ('债权', '信用债')
    if first3 == '688' or first1 == '6' or first2 in ('00','30') or first1 == '8':
        return ('股权', 'A股')
    if len(clean) <= 4 and clean.isalpha():
        return ('股权', '美股')
    return ('股权', 'A股')

# 跳过这些特殊代码
SKIP_CODES = {'888880'}  # 标准券
# 可转债打新中签的临时项（股票余额为0但可能有可申购数量）
SKIP_ZERO_QTY_NAMES = {'宝钛发债','鼎通发债','恒达发债','利元发债','华康发债','福立发债'}

def parse_a_shares(path):
    """解析A股持仓文件"""
    positions = []
    trades = []
    with open(path, 'r', encoding='gb18030') as f:
        reader = csv.DictReader(f, delimiter='\t')
        for row in reader:
            code = row.get('证券代码', '').strip()
            name = row.get('证券名称', '').strip()
            qty_str = row.get('股票余额', '0').strip()
            cost_str = row.get('成本价', '0').strip()
            unit = row.get('数量单位', '股').strip()
            market = row.get('市场类别', '').strip()
            
            try:
                qty = int(float(qty_str)) if qty_str else 0
            except:
                qty = 0
            try:
                cost = float(cost_str) if cost_str else 0
            except:
                cost = 0
            
            if qty <= 0:
                continue
            if code in SKIP_CODES:
                print(f'  跳过特殊品种: {code} {name}')
                continue
            if name in SKIP_ZERO_QTY_NAMES:
                print(f'  跳过打新临时项: {code} {name}')
                continue
            # 成本价为负数的股票（除权除息导致），用0替代
            if cost < 0:
                print(f'  注意: {code} {name} 成本价为负({cost})，设为0')
                cost = 0
            
            type_, subtype = classify(code)
            # 如果市场类别包含"股转"，标记为新三板
            if '股转' in market:
                subtype = 'A股'
            
            # 上交所可转债（11开头）: 券商导出数量单位为"手"，1手=10张
            # 深交所可转债（12开头）: 数量单位为"张"，无需转换
            if subtype == '可转债' and code.startswith('11'):
                qty = qty * 10
                print(f'  [上交所可转债] {code} {name}: 手→张 ×10, 数量={qty}')
            
            pos_id = uid()
            # 金额 = 成本价 × 数量（初始建仓成本）
            amount = round(cost * qty, 2)
            
            position = {
                'id': pos_id,
                'code': code,
                'name': name,
                'price': cost,
                'quantity': qty,
                'cost': cost,
                'type': type_,
                'subtype': subtype,
                'note': ''
            }
            positions.append(position)
            
            trade = {
                'id': uid(),
                'date': '2026-06-26',
                'code': code,
                'name': name,
                'direction': 'buy',
                'price': cost,
                'quantity': qty,
                'amount': amount,
                'type': type_,
                'subtype': subtype,
                'note': '券商导出导入'
            }
            trades.append(trade)
            
            print(f'  {code} {name}: {qty}{unit} @ {cost:.4f} → {type_}/{subtype}')
    
    return positions, trades

def parse_hk_shares(path):
    """解析港股通持仓文件"""
    positions = []
    trades = []
    with open(path, 'r', encoding='gb18030') as f:
        reader = csv.DictReader(f, delimiter='\t')
        for row in reader:
            code = row.get('证券代码', '').strip()
            name = row.get('证券名称', '').strip()
            qty_str = (row.get('当前数量') or row.get('股票余额', '0')).strip()
            cost_cny_str = row.get('成本价(元)', '0').strip()
            
            try:
                qty = int(float(qty_str)) if qty_str else 0
            except:
                qty = 0
            try:
                cost_cny = float(cost_cny_str) if cost_cny_str else 0
            except:
                cost_cny = 0
            
            if qty <= 0:
                print(f'  跳过空仓: {code} {name} (余额={qty_str})')
                continue
            if cost_cny < 0:
                print(f'  注意: {code} {name} 成本价为负({cost_cny})，设为0')
                cost_cny = 0
            
            # 港股代码固定5位，补前导0
            code = code.zfill(5)
            
            # 港股通统一标记为港股
            pos_id = uid()
            amount = round(cost_cny * qty, 2)
            
            position = {
                'id': pos_id,
                'code': code,
                'name': name,
                'price': cost_cny,
                'quantity': qty,
                'cost': cost_cny,
                'type': '股权',
                'subtype': '港股',
                'note': ''
            }
            positions.append(position)
            
            trade = {
                'id': uid(),
                'date': '2026-06-26',
                'code': code,
                'name': name,
                'direction': 'buy',
                'price': cost_cny,
                'quantity': qty,
                'amount': amount,
                'type': '股权',
                'subtype': '港股',
                'note': '券商导出导入'
            }
            trades.append(trade)
            
            print(f'  {code} {name}: {qty}股 @ {cost_cny:.4f}元 → 港股')
    
    return positions, trades

def main():
    print("=== 导入A股持仓 ===")
    a_pos, a_trades = parse_a_shares(FILE1)
    print(f"\nA股: {len(a_pos)} 只持仓, {len(a_trades)} 笔交易")
    
    print("\n=== 导入港股通持仓 ===")
    hk_pos, hk_trades = parse_hk_shares(FILE2)
    print(f"\n港股: {len(hk_pos)} 只持仓, {len(hk_trades)} 笔交易")
    
    # 合并数据
    all_positions = a_pos + hk_pos
    all_trades = a_trades + hk_trades
    
    # 去重（相同代码只保留一条）
    seen_codes = set()
    deduped_positions = []
    for p in all_positions:
        code = p['code']
        # 港股代码补零去重（如 00152 vs 152）
        code_norm = code.lstrip('0')
        if code_norm in seen_codes or code in seen_codes:
            print(f'  去重跳过: {p["code"]} {p["name"]}')
            continue
        seen_codes.add(code)
        seen_codes.add(code_norm)
        deduped_positions.append(p)
    
    # 计算总现金：成本总额的相反数（模拟已投入资金）
    total_cost = sum(p['cost'] * p['quantity'] for p in deduped_positions if p['cost'] > 0)
    
    data = {
        'positions': deduped_positions,
        'trades': all_trades,
        'cash': -total_cost,
        'navHistory': []
    }

    # 写入 PostgreSQL
    conn = get_conn()
    cursor = conn.cursor()
    # 检查用户是否存在
    cursor.execute("SELECT username FROM users WHERE username = %s", (USER,))
    user = cursor.fetchone()
    if not user:
        print(f"\n错误: 数据库中不存在用户 '{USER}'，请先注册或指定 --user=xxx")
        conn.close()
        return
    
    # upsert 写入 account_data（与 server/db.js 的 ON CONFLICT 策略一致）
    data_json = json.dumps(data, ensure_ascii=False)
    cursor.execute(
        "INSERT INTO account_data (username, account_name, data, updated_at) "
        "VALUES (%s, %s, %s, to_char(now(), 'YYYY-MM-DD HH24:MI:SS')) "
        "ON CONFLICT (username, account_name) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at",
        (USER, '华泰账户', data_json)
    )
    conn.commit()
    conn.close()

    print(f"\n=== 汇总 ===")
    print(f"用户: {USER}")
    print(f"持仓数: {len(deduped_positions)} 只")
    print(f"交易数: {len(all_trades)} 笔")
    print(f"数据库: PostgreSQL (PGDATABASE={os.environ.get('PGDATABASE', 'portfolio')})")

if __name__ == '__main__':
    main()
