import json

with open(r'D:\Users\持仓跟踪\portfolio-server\data\daicunzai__华泰账户.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

total_asset = 2462607.72
positions_market_value = sum(p['price'] * p['quantity'] for p in data['positions'])
cash = round(total_asset - positions_market_value, 2)

print(f"总市值: {total_asset:.2f}")
print(f"持仓市值: {positions_market_value:.2f}")
print(f"现金: {cash:.2f}")

# 更新
data['cash'] = cash

with open(r'D:\Users\持仓跟踪\portfolio-server\data\daicunzai__华泰账户.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("已更新")
