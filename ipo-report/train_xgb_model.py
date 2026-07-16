"""
训练XGBoost新股首日涨幅预测模型（无pandas依赖）
数据来源：ipo_history.db
模型输出：ipo_xgb_model.json
"""
import sqlite3
import os
import json
import warnings
import numpy as np
warnings.filterwarnings("ignore")

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_history.db")
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_xgb_model.json")
FEATURES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_xgb_features.json")

# ── 1. 加载数据 ──
conn = sqlite3.connect(DB_PATH)
rows = conn.execute("""
    SELECT 
        security_code, security_name, board_key, ld_close_change,
        issue_price, issue_pe, industry_pe, fund_raised,
        online_shares, total_shares, online_lottery_rate,
        oversubscribe_multiple, circulation_mv, subscribe_upper_limit,
        pe_ratio
    FROM ipo_history 
    WHERE board_key != '北交所' 
      AND ld_close_change IS NOT NULL
    ORDER BY listing_date
""").fetchall()
conn.close()

print(f"加载 {len(rows)} 只新股")

# ── 2. 特征工程 ──
names = ['code', 'name', 'board', 'gain',
         'issue_price', 'issue_pe', 'industry_pe', 'fund_raised',
         'online_shares', 'total_shares', 'lottery_rate',
         'oversub_multiple', 'circ_mv', 'sub_limit', 'pe_ratio']

data = {k: [] for k in names}
for r in rows:
    for i, k in enumerate(names):
        data[k].append(r[i])

def to_float(arr):
    return [float(x) if x is not None else np.nan for x in arr]

gain = np.array(to_float(data['gain']))
issue_price = np.array(to_float(data['issue_price']))
issue_pe = np.array(to_float(data['issue_pe']))
industry_pe = np.array(to_float(data['industry_pe']))
fund_raised = np.array(to_float(data['fund_raised']))
online_shares = np.array(to_float(data['online_shares']))
total_shares = np.array(to_float(data['total_shares']))
lottery_rate = np.array(to_float(data['lottery_rate']))
oversub = np.array(to_float(data['oversub_multiple']))
circ_mv = np.array(to_float(data['circ_mv']))
sub_limit = np.array(to_float(data['sub_limit']))
pe_ratio = np.array(to_float(data['pe_ratio']))
codes = data['code']
names_list = data['name']

# 缺失值：用中位数填充
def fill_median(arr):
    m = np.nanmedian(arr)
    arr = np.nan_to_num(arr, nan=m)
    return arr, m

medians = {}
issue_price, medians['issue_price'] = issue_price, 0
issue_pe, medians['issue_pe'] = fill_median(issue_pe)
industry_pe, medians['industry_pe'] = fill_median(industry_pe)
fund_raised, medians['fund_raised'] = fund_raised, 0
online_shares, medians['online_shares'] = online_shares, 0
total_shares, medians['total_shares'] = total_shares, 0
lottery_rate, medians['lottery_rate'] = fill_median(lottery_rate)
oversub, medians['oversub_multiple'] = fill_median(oversub)
circ_mv, medians['circ_mv'] = fill_median(circ_mv)
sub_limit, medians['sub_limit'] = sub_limit, 0
pe_ratio, medians['pe_ratio'] = fill_median(pe_ratio)

# 衍生特征
circ_mv_log = np.log1p(circ_mv)
fund_log = np.log1p(fund_raised)
price_times_pe = issue_price * issue_pe / 100
lottery_inv = 1 / (lottery_rate + 0.001)
circ_per_lot = circ_mv / (lottery_rate + 0.001)
pe_squared = issue_pe ** 2 / 1000

# 特征矩阵
all_features = np.column_stack([
    issue_price, issue_pe, industry_pe, fund_raised,
    online_shares, total_shares, lottery_rate,
    oversub, circ_mv, sub_limit, pe_ratio,
    circ_mv_log, fund_log, price_times_pe,
        lottery_inv, circ_per_lot, pe_squared
])
feature_names = [
    'issue_price', 'issue_pe', 'industry_pe', 'fund_raised',
    'online_shares', 'total_shares', 'lottery_rate',
    'oversub_multiple', 'circ_mv', 'sub_limit', 'pe_ratio',
    'circ_mv_log', 'fund_log', 'price_times_pe',
    'lottery_inv', 'circ_per_lot', 'pe_squared'
]

# 训练/测试分割（时间顺序）
n = len(rows)
train_size = int(n * 0.8)
X_train = all_features[:train_size]
y_train = gain[:train_size]
X_test = all_features[train_size:]
y_test = gain[train_size:]

print(f"训练集: {train_size} 只, 测试集: {n - train_size} 只")
print(f"特征数: {len(feature_names)}")

# ── 3. 训练XGBoost ──
import xgboost as xgb

model = xgb.XGBRegressor(
    n_estimators=500,
    max_depth=3,
    learning_rate=0.05,
    subsample=0.7,
    colsample_bytree=0.7,
    reg_alpha=2.0,
    reg_lambda=3.0,
    min_child_weight=5,
    random_state=42,
    verbosity=0,
    early_stopping_rounds=20,
)

model.fit(
    X_train, y_train,
    eval_set=[(X_test, y_test)],
    verbose=False
)

# 获取最佳迭代次数
best_iter = model.best_iteration if hasattr(model, 'best_iteration') and model.best_iteration is not None else None
if best_iter:
    print(f"最佳迭代次数: {best_iter}")

# ── 4. 评估 ──
y_pred_train = model.predict(X_train)
y_pred_test = model.predict(X_test)

train_mae = np.mean(np.abs(y_train - y_pred_train))
test_mae = np.mean(np.abs(y_test - y_pred_test))
train_mape = np.mean(np.abs((y_train - y_pred_train) / (y_train + 1))) * 100
test_mape = np.mean(np.abs((y_test - y_pred_test) / (y_test + 1))) * 100

print(f"\n{'='*50}")
print(f"训练集 MAE: {train_mae:.0f}pp")
print(f"测试集 MAE: {test_mae:.0f}pp")
print(f"训练集 MAPE: {train_mape:.1f}%")
print(f"测试集 MAPE: {test_mape:.1f}%")
print(f"{'='*50}\n")

# 测试集逐只对比
print(f"{'代码':>8} {'名称':<8} {'预测':>7} {'实际':>7} {'偏差':>7}")
test_codes = codes[train_size:]
test_names = names_list[train_size:]
for i in range(len(y_test)):
    print(f"{test_codes[i]:>8} {test_names[i]:<8} {y_pred_test[i]:>6.0f}% {y_test[i]:>6.0f}% {y_pred_test[i]-y_test[i]:>+6.0f}pp")

# 特征重要性
print(f"\n特征重要性（TOP10）:")
importance = model.feature_importances_
idx_sorted = np.argsort(importance)[::-1]
for i in idx_sorted[:10]:
    print(f"  {feature_names[i]}: {importance[i]:.3f}")

# ── 5. 保存 ──
try:
    model.save_model(MODEL_PATH)
except TypeError:
    # xgboost 3.x兼容性问题
    model.get_booster().save_model(MODEL_PATH)

info = {
    "features": feature_names,
    "medians": {k: float(v) for k, v in medians.items() if not np.isnan(v)},
    "sample_count": n,
    "train_mae": float(train_mae),
    "test_mae": float(test_mae),
    "train_mape": float(train_mape),
    "test_mape": float(test_mape),
}
with open(FEATURES_PATH, "w", encoding="utf-8") as f:
    json.dump(info, f, ensure_ascii=False, indent=2)

print(f"\n模型已保存: {MODEL_PATH}")
print(f"特征信息已保存: {FEATURES_PATH}")
