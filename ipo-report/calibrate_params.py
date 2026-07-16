"""
自动调参脚本：从ipo_history获取最近20只非北交所新股，
从东财详情页获取完整发行数据，运行预测模型后与实际涨幅对比，
通过网格搜索调优各因子系数。
"""
import requests
import re
import sqlite3
import json
import os
import sys

# 从主脚本导入赛道关键词
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ipo_daily_report import NEW_STOCK_HOT_SECTORS

s = requests.Session()
s.headers.update({'User-Agent': 'Mozilla/5.0'})

# 1. 获取最近20只非北交所新股
conn = sqlite3.connect(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_history.db"))
rows = conn.execute("""
    SELECT security_code, security_name, board_key, ld_close_change, listing_date 
    FROM ipo_history 
    WHERE board_key != '北交所'
    ORDER BY listing_date DESC LIMIT 20
""").fetchall()
conn.close()

print(f"找到 {len(rows)} 只非北交所新股\n")

all_stocks = []
for code, name, board, actual_gain, date in rows:
    url = f"https://ds.emoney.cn/DataCenter2/datacenter/NewStockXgzl?secucode={code}&type=ss"
    try:
        resp = s.get(url, timeout=15)
        html = resp.text
    except:
        print(f"  {code} {name}: 请求失败，跳过")
        continue

    rows2 = re.findall(r"<tr>(.*?)</tr>", html, re.DOTALL)
    data = {}
    for row in rows2:
        tds = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.DOTALL)
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in tds]
        for i in range(len(cells) - 1):
            data[cells[i]] = cells[i + 1]

    def get_float(key, default=None):
        v = data.get(key, "")
        try:
            return float(v)
        except:
            return default

    ip = get_float("发行价格(元／股)")
    ipe = get_float("发行市盈率")
    ind_pe = get_float("参考行业市盈率(倍)") or get_float("行业市盈率")
    fr = get_float("实际募集资金总额(亿元)")
    os_ = get_float("网上发行数量(万股)")
    lr = get_float("网上发行中签率(%)")
    mb = data.get("主营业务", "")
    ind = data.get("参考行业", "") or data.get("所属行业", "")
    actual = actual_gain

    # 首日流通市值
    cmv = round(os_ * ip / 10000, 2) if os_ and ip else None

    # 赛道匹配
    search = f"{data.get('股票简称','')} {mb} {ind}"
    best_label, best_boost = None, 0
    for kw, boost in NEW_STOCK_HOT_SECTORS.items():
        if kw in search and boost > best_boost:
            best_boost, best_label = boost, kw

    # 板块基准
    board_map = {"创业板": 284, "深市主板": 180, "沪市主板": 245, "科创板": 332}
    board_base = board_map.get(board, 180)

    # 机构超额认购倍数
    oversub = get_float("机构超额认购倍数")

    stock = {
        "code": code, "name": name, "board": board,
        "board_base": board_base,
        "issue_price": ip, "issue_pe": ipe, "industry_pe": ind_pe,
        "fund_raised": fr, "online_shares": os_,
        "lottery_rate": lr, "circulation_mv": cmv,
        "sector_label": best_label, "sector_boost": best_boost,
        "actual_gain": actual,
        "oversubscribe_multiple": oversub,
        "main_business": mb[:60] if mb else "",
    }
    all_stocks.append(stock)

    print(f"  {code} {name} {board} 发行价{ip} PE{ipe} 中签率{lr}% "
          f"流通{cmv}亿 赛道{best_label or '-'} 实际{actual:.0f}%")

print(f"\n成功获取 {len(all_stocks)} 只新股数据\n")

# 2. 预测函数（可调参版本）
def predict(stock, params):
    """
    params: {
        'sector_listing': 0.15,     # 赛道上市加成系数
        'sector_apply': 0.30,       # 赛道申购加成系数
        'price_low_threshold': 15,  # 低价股阈值
        'price_low_mult': 1.10,     # 低价股加成
        'price_med_threshold': 30,  # 中等价格阈值
        'price_med_mult': 1.05,     # 中等价格加成
        'price_high_threshold': 80, # 高价股阈值
        'price_high_mult': 0.90,    # 高价股惩罚
        'lr_extreme_threshold': 0.02, # 极低中签率阈值
        'lr_extreme_mult': 1.15,
        'lr_low_threshold': 0.03,
        'lr_low_mult': 1.10,
        'lr_high_threshold': 0.08,
        'lr_high_mult': 0.92,
        'lr_vhigh_threshold': 0.12,
        'lr_vhigh_mult': 0.85,
        'cmv_vsmall_threshold': 3,
        'cmv_vsmall_mult': 1.25,
        'cmv_small_threshold': 6,
        'cmv_small_mult': 1.15,
        'cmv_med_threshold': 10,
        'cmv_med_mult': 1.05,
        'cmv_large_threshold': 20,
        'cmv_large_mult': 0.90,
        'cmv_vlarge_threshold': 50,
        'cmv_vlarge_mult': 0.80,
        'fund_large_threshold': 50,
        'fund_large_mult': 0.85,
        'fund_med_threshold': 20,
        'fund_med_mult': 0.95,
    }
    """
    est = float(stock['board_base'])

    # 赛道
    if stock['sector_boost']:
        est *= (1 + stock['sector_boost'] * params['sector_listing'])
        # 科创板+热门赛道叠加效应
        if stock['code'].startswith(('688', '787')):
            est *= 1.25
            if stock['sector_boost'] >= 1.0:
                est *= 1.2

    # 发行价
    ip = stock['issue_price']
    if ip:
        if ip < params['price_low_threshold']:
            est *= params['price_low_mult']
        elif ip < params['price_med_threshold']:
            est *= params['price_med_mult']
        elif ip > 50:  # 高价阈值改为50
            est *= 0.90

    # 募资规模
    fr = stock['fund_raised']
    if fr:
        if fr > params['fund_large_threshold']:
            est *= params['fund_large_mult']
        elif fr > params['fund_med_threshold']:
            est *= params['fund_med_mult']

    # 中签率
    lr = stock['lottery_rate']
    if lr:
        if lr < params['lr_extreme_threshold']:
            est *= params['lr_extreme_mult']
        elif lr < params['lr_low_threshold']:
            est *= params['lr_low_mult']
        elif lr > params['lr_vhigh_threshold']:
            est *= params['lr_vhigh_mult']
        elif lr > params['lr_high_threshold']:
            est *= params['lr_high_mult']

    # 流通市值
    cmv = stock['circulation_mv']
    if cmv:
        if cmv < params['cmv_vsmall_threshold']:
            est *= params['cmv_vsmall_mult']
        elif cmv < params['cmv_small_threshold']:
            est *= params['cmv_small_mult']
        elif cmv < params['cmv_med_threshold']:
            est *= params['cmv_med_mult']
        elif cmv > params['cmv_vlarge_threshold']:
            est *= params['cmv_vlarge_mult']
        elif cmv > params['cmv_large_threshold']:
            est *= params['cmv_large_mult']

    # 超额认购倍数（如果有数据）
    oversub = stock.get('oversubscribe_multiple')
    if oversub:
        if oversub > 5000:
            est *= 1.10
        elif oversub > 3000:
            est *= 1.05
        elif oversub < 500:
            est *= 0.92

    return int(round(est))


# 3. 评估函数：计算平均绝对百分比误差
def evaluate(params, stocks):
    errors = []
    for st in stocks:
        pred = predict(st, params)
        actual = st['actual_gain']
        if actual > 0:
            # 使用相对误差
            err = abs(pred - actual) / actual * 100
            errors.append(err)
    return sum(errors) / len(errors) if errors else 999


# 4. 基准测试（当前参数）
base_params = {
    'sector_listing': 0.15,
    'price_low_threshold': 15, 'price_low_mult': 1.10,
    'price_med_threshold': 30, 'price_med_mult': 1.05,
    'price_high_threshold': 80, 'price_high_mult': 0.90,
    'lr_extreme_threshold': 0.02, 'lr_extreme_mult': 1.15,
    'lr_low_threshold': 0.03, 'lr_low_mult': 1.10,
    'lr_high_threshold': 0.08, 'lr_high_mult': 0.92,
    'lr_vhigh_threshold': 0.12, 'lr_vhigh_mult': 0.85,
    'cmv_vsmall_threshold': 3, 'cmv_vsmall_mult': 1.25,
    'cmv_small_threshold': 6, 'cmv_small_mult': 1.15,
    'cmv_med_threshold': 10, 'cmv_med_mult': 1.05,
    'cmv_large_threshold': 20, 'cmv_large_mult': 0.90,
    'cmv_vlarge_threshold': 50, 'cmv_vlarge_mult': 0.80,
    'fund_large_threshold': 50, 'fund_large_mult': 0.85,
    'fund_med_threshold': 20, 'fund_med_mult': 0.95,
}

base_err = evaluate(base_params, all_stocks)
print(f"当前参数平均相对误差: {base_err:.1f}%")
print()

# 逐只打印预测 vs 实际
print(f"{'代码':>8} {'名称':<8} {'预测':>6} {'实际':>6} {'偏差':>6}")
for st in all_stocks:
    pred = predict(st, base_params)
    actual = st['actual_gain']
    err = pred - actual
    print(f"{st['code']:>8} {st['name']:<8} {pred:>6}% {actual:>6.0f}% {err:>+6.0f}pp")

print(f"\n{'='*60}")
print(f"平均绝对误差: {sum(abs(predict(st,base_params)-st['actual_gain']) for st in all_stocks)/len(all_stocks):.0f}pp")

# 5. 参数优化：网格搜索关键参数
print(f"\n{'='*60}")
print(f"参数优化 - 网格搜索")
print(f"{'='*60}")

best_params = base_params.copy()
best_err = base_err

# 待优化的参数及候选值
search_params = {
    'sector_listing': [0.15, 0.20, 0.25, 0.30],
    'price_low_mult': [1.05, 1.10, 1.15, 1.20],
    'lr_extreme_mult': [1.10, 1.15, 1.20, 1.25],
    'cmv_vsmall_mult': [1.20, 1.25, 1.30, 1.35],
    'cmv_small_mult': [1.10, 1.15, 1.20],
    'cmv_med_mult': [1.00, 1.05, 1.10],
    'cmv_large_mult': [0.85, 0.90, 0.95],
    'cmv_vlarge_mult': [0.75, 0.80, 0.85],
}

for param_name, candidates in search_params.items():
    orig_val = best_params[param_name]
    best_val = orig_val
    for c in candidates:
        test_params = best_params.copy()
        test_params[param_name] = c
        err = evaluate(test_params, all_stocks)
        if err < best_err:
            best_err = err
            best_val = c
            best_params[param_name] = c
    if best_val != orig_val:
        print(f"  {param_name}: {orig_val} → {best_val}（误差{best_err:.1f}%）")

print(f"\n优化后参数平均相对误差: {best_err:.1f}%")
print(f"原始误差: {base_err:.1f}%")
print(f"改进: {base_err - best_err:.1f}个百分点")

# 6. 输出优化后的参数（只输出有变化的）
print(f"\n{'='*60}")
print(f"优化后参数（变更部分）:")
for k, v in best_params.items():
    if v != base_params[k]:
        print(f"  {k}: {base_params[k]} → {v}")

print(f"\n优化后完整预测:")
print(f"{'代码':>8} {'名称':<8} {'预测':>6} {'实际':>6} {'偏差':>6}")
for st in all_stocks:
    pred = predict(st, best_params)
    actual = st['actual_gain']
    err = pred - actual
    print(f"{st['code']:>8} {st['name']:<8} {pred:>6}% {actual:>6.0f}% {err:>+6.0f}pp")
