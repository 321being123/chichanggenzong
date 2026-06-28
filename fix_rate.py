import json

with open(r'D:\Users\持仓跟踪\portfolio-server\data\daicunzai__华泰账户.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

HK_RATE = 0.868  # 三位小数

for p in data['positions']:
    if p.get('subtype') == '港股':
        old_price = p['price']
        # 从数据中恢复港币价格：当前price是用0.87算的，需要÷0.87×0.868
        # 但最简单的是直接用原始港币价×新汇率
        # 我们不知道原始港币价，所以用 当前价格 ÷ 0.87 × 0.868
        p['price'] = round(p['price'] / 0.87 * 0.868, 4)
        print(f"  {p['code']} {p['name']}: {old_price:.4f} -> {p['price']:.4f}")

positions_mv = sum(p['price'] * p['quantity'] for p in data['positions'])
total_asset = 2462607.72
cash = round(total_asset - positions_mv, 2)

print(f"\n总市值: {total_asset:.2f}")
print(f"持仓市值: {positions_mv:.2f}")
print(f"现金: {cash:.2f}")
print(f"汇率: 0.87 -> 0.868")

data['cash'] = cash

with open(r'D:\Users\持仓跟踪\portfolio-server\data\daicunzai__华泰账户.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("已更新")
