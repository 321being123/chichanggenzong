import json

with open(r'D:\Users\持仓跟踪\portfolio-server\data\daicunzai__华泰账户.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# 把港股价格恢复为港币（之前是人民币，除以0.868得到港币）
HK_RATE = 0.868

for p in data['positions']:
    if p.get('subtype') == '港股':
        cny_price = p['price']
        hkd_price = round(cny_price / HK_RATE, 4)
        p['price'] = hkd_price
        print(f"  {p['code']} {p['name']}: {cny_price:.4f} CNY -> {hkd_price:.4f} HKD")

# 重新计算持仓市值（港股市值需×汇率）
def get_mv(pos):
    mv = (pos['price'] or 0) * (pos['quantity'] or 0)
    if pos.get('subtype') == '港股':
        mv = mv * HK_RATE
    return mv

positions_mv = sum(get_mv(p) for p in data['positions'])
total_asset = 2462607.72
cash = round(total_asset - positions_mv, 2)

print(f"\n总市值: {total_asset:.2f}")
print(f"持仓市值: {positions_mv:.2f}")
print(f"现金: {cash:.2f}")
print(f"汇率: {HK_RATE}")

data['cash'] = cash
# 写入汇率
data['hkRate'] = HK_RATE

with open(r'D:\Users\持仓跟踪\portfolio-server\data\daicunzai__华泰账户.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("已更新")
