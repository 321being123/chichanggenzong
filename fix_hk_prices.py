import json

with open(r'D:\Users\持仓跟踪\portfolio-server\data\daicunzai__华泰账户.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

HK_RATE = 0.87

for p in data['positions']:
    if p.get('subtype') == '港股':
        old_price = p['price']
        p['price'] = round(p['price'] * HK_RATE, 4)
        print(f"  {p['code']} {p['name']}: {old_price} HKD -> {p['price']} CNY (×{HK_RATE})")

# 重新计算持仓市值
positions_mv = sum(p['price'] * p['quantity'] for p in data['positions'])
total_asset = 2462607.72
cash = round(total_asset - positions_mv, 2)

print(f"\n总市值: {total_asset:.2f}")
print(f"持仓市值: {positions_mv:.2f}")
print(f"现金: {cash:.2f}")

data['cash'] = cash

with open(r'D:\Users\持仓跟踪\portfolio-server\data\daicunzai__华泰账户.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("已更新")
