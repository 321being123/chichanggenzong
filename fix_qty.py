# -*- coding: utf-8 -*-
"""修正导入错误：港股数量用"当前数量"而非"股票余额" """
import json, csv, os, time

DATA_FILE = r'D:\Users\持仓跟踪\portfolio-server\data\daicunzai__华泰账户.json'
FILE_HK = r'C:\Users\戴存在\Desktop\tab1le.xls'
FILE_A = r'C:\Users\戴存在\Desktop\table.xls'
TOTAL_ASSET = 2462607.72
HK_RATE = 0.87

def uid():
    return format(int(time.time() * 1000), 'x') + format(int.from_bytes(os.urandom(4), 'big'), 'x')

def classify(code):
    clean = code.strip().upper()
    if not clean or not clean.replace('.SH','').replace('.SZ','').replace('.HK','').replace('.US','').replace('SH','').replace('SZ','').replace('HK','').replace('US','').isdigit():
        return ('股权', 'A股')
    num = clean.replace('.SH','').replace('.SZ','').replace('.HK','').replace('.US','').replace('SH','').replace('SZ','').replace('HK','').replace('US','')
    if len(num) <= 5: return ('股权', '港股')
    first3, first2, first1 = num[:3], num[:2], num[:1]
    if first3 in ('123','127') or first2 in ('11','12'): return ('债权', '可转债')
    if first2 == '13': return ('债权', '信用债')
    if first3 == '688' or first1 == '6' or first2 in ('00','30') or first1 == '8': return ('股权', 'A股')
    return ('股权', 'A股')

# 1. 读取原始数据，构建正确的持仓列表
correct_positions = []
correct_trades = []
total_cost = 0

# --- A股 ---
with open(FILE_A, 'r', encoding='gb18030') as f:
    reader = csv.DictReader(f, delimiter='\t')
    for row in reader:
        code = row['证券代码'].strip()
        name = row['证券名称'].strip()
        qty = int(float(row['股票余额'].strip())) if row['股票余额'].strip() else 0
        cost = float(row['成本价'].strip()) if row['成本价'].strip() else 0
        if qty <= 0 or code in {'888880'} or name in {'宝钛发债','鼎通发债'}: continue
        if cost < 0: cost = 0
        type_, subtype = classify(code)
        if '股转' in row.get('市场类别',''): subtype = 'A股'
        pid = uid()
        amt = round(cost * qty, 2)
        correct_positions.append({'id': pid, 'code': code, 'name': name, 'price': cost, 'quantity': qty, 'cost': cost, 'type': type_, 'subtype': subtype, 'note': ''})
        correct_trades.append({'id': uid(), 'date': '2026-06-26', 'code': code, 'name': name, 'direction': 'buy', 'price': cost, 'quantity': qty, 'amount': amt, 'type': type_, 'subtype': subtype, 'note': '券商导出导入'})
        total_cost += cost * qty

# --- 港股（用"当前数量"而非"股票余额"）---
with open(FILE_HK, 'r', encoding='gb18030') as f:
    reader = csv.DictReader(f, delimiter='\t')
    for row in reader:
        code = row['证券代码'].strip()
        name = row['证券名称'].strip()
        qty = int(float(row['当前数量'].strip())) if row['当前数量'].strip() else 0   # ← 关键修复
        cost_cny = float(row['成本价(元)'].strip()) if row['成本价(元)'].strip() else 0
        hk_price = float(row['最新价(港元)'].strip()) if row['最新价(港元)'].strip() else 0
        if qty <= 0: continue
        if cost_cny < 0: cost_cny = 0
        cny_price = round(hk_price * HK_RATE, 4)
        pid = uid()
        amt = round(cost_cny * qty, 2)
        correct_positions.append({'id': pid, 'code': code, 'name': name, 'price': cny_price, 'quantity': qty, 'cost': cost_cny, 'type': '股权', 'subtype': '港股', 'note': ''})
        correct_trades.append({'id': uid(), 'date': '2026-06-26', 'code': code, 'name': name, 'direction': 'buy', 'price': cost_cny, 'quantity': qty, 'amount': amt, 'type': '股权', 'subtype': '港股', 'note': '券商导出导入'})
        total_cost += cost_cny * qty
        print(f'  {code} {name}: {qty}股 成本{cost_cny:.4f} 最新价{cny_price:.4f}')

# 去重
seen = set()
deduped = []
for p in correct_positions:
    c = p['code'].lstrip('0')
    if c in seen or p['code'] in seen: continue
    seen.add(c); seen.add(p['code']); deduped.append(p)

positions_mv = sum(p['price'] * p['quantity'] for p in deduped)
cash = round(TOTAL_ASSET - positions_mv, 2)

print(f"\n=== 修正后 ===")
print(f"持仓数: {len(deduped)} 只")
print(f"持仓市值: {positions_mv:.2f}")
print(f"现金: {cash:.2f}")

data = {'positions': deduped, 'trades': correct_trades, 'cash': cash, 'navHistory': [], 'cashFlows': []}
with open(DATA_FILE, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print(f"已写入: {DATA_FILE}")
