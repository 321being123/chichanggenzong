"""
训练XGBoost新股首日涨幅预测模型（无pandas依赖）
数据来源：PostgreSQL ipo_history（SQLite 仅作旧环境回退）
模型输出：IPO_MODEL_DIR/ipo_xgb_model.json

特征工程、目标变换与超参见 ipo_lib_train.py，与时间滚动回测（backtest_ipo_prediction.py）共用，
避免两处各写一套口径导致回测结论与实际训练不符。
"""
import os
import json
import tempfile
import warnings
import numpy as np
from datetime import datetime

from model_runtime import get_model_dir
from ipo_lib_train import (
    FITTED_MEDIAN_FIELDS,
    NATIVE_MISSING_FIELDS,
    FEATURE_NAMES,
    XGB_PARAMS,
    NUM_BOOST_ROUND,
    symlog_return,
    inv_symlog_return,
    build_feature_matrix,
    load_training_rows,
    rows_to_arrays,
)

warnings.filterwarnings("ignore")

MODEL_DIR = get_model_dir()
MODEL_PATH = os.path.join(MODEL_DIR, "ipo_xgb_model.json")
FEATURES_PATH = os.path.join(MODEL_DIR, "ipo_xgb_features.json")
os.makedirs(MODEL_DIR, exist_ok=True)

feature_names = FEATURE_NAMES

# ── 1. 加载数据 ──
rows = load_training_rows()
if not rows:
    raise RuntimeError("没有可用于训练的已上市新股历史数据")

print(f"加载 {len(rows)} 只新股")

# ── 2. 特征工程 ──
raw_fields, codes, names_list, gain = rows_to_arrays(rows)

# 全量中位数：上线模型用全部样本训练，补位值即取自全部样本。
medians = {field: float(np.nanmedian(raw_fields[field])) for field in FITTED_MEDIAN_FIELDS}
fill_sources = {field: "median_of_existing_samples" for field in FITTED_MEDIAN_FIELDS}
fill_sources.update({field: "native_missing" for field in NATIVE_MISSING_FIELDS})

# 时间顺序切分：前 80% 作训练段，后 20% 作样本外测试段
n = len(rows)
train_size = int(n * 0.8)
y_train = gain[:train_size]
y_test = gain[train_size:]

# 评估专用特征：训练段与测试段都用**训练段**中位数补值，
# 避免测试段样本进入补值统计（原先先补值再切分，测试集信息会回灌到训练特征）。
eval_medians = {field: float(np.nanmedian(raw_fields[field][:train_size])) for field in FITTED_MEDIAN_FIELDS}
eval_features = build_feature_matrix(raw_fields, eval_medians)
X_train = eval_features[:train_size]
X_test = eval_features[train_size:]

# 目标变换：奇对称对数，保留破发（负收益）的符号与量级
y_train_target = symlog_return(y_train)
y_test_target = symlog_return(y_test)

print(f"训练集: {train_size} 只, 测试集: {n - train_size} 只")
print(f"特征数: {len(feature_names)}")

# ── 3. 训练XGBoost ──
import xgboost as xgb

dtrain = xgb.DMatrix(X_train, label=y_train_target, feature_names=feature_names)
dtest = xgb.DMatrix(X_test, label=y_test_target, feature_names=feature_names)

# 评估模型：只用训练段训练，得到的指标才是样本外指标
eval_model = xgb.train(XGB_PARAMS, dtrain, num_boost_round=NUM_BOOST_ROUND)

# 上线模型：用**全部**样本重训。此前上线模型与评估模型是同一个（只用训练段 80% 训练），
# 最新的 20% 样本从未参与训练；评估职责现在由 eval_model 承担，两者不再混用。
all_features = build_feature_matrix(raw_fields, medians)
dfull = xgb.DMatrix(all_features, label=symlog_return(gain), feature_names=feature_names)
model = xgb.train(XGB_PARAMS, dfull, num_boost_round=NUM_BOOST_ROUND)

# 获取最佳迭代次数
best_iter = model.best_iteration if hasattr(model, 'best_iteration') and model.best_iteration is not None else None
if best_iter:
    print(f"最佳迭代次数: {best_iter}")

# ── 4. 评估（均为 eval_model 的样本外表现）──
y_pred_train = inv_symlog_return(eval_model.predict(dtrain))
y_pred_test = inv_symlog_return(eval_model.predict(dtest))

train_mae = np.mean(np.abs(y_train - y_pred_train))
test_mae = np.mean(np.abs(y_test - y_pred_test))
train_mape = np.mean(np.abs((y_train - y_pred_train) / (y_train + 1))) * 100
test_mape = np.mean(np.abs((y_test - y_pred_test) / (y_test + 1))) * 100

# 预测区间半宽：取滚动样本外绝对误差的 80 分位数，替代原先的经验系数 test_mae*0.6。
# 实证：旧口径给出 140pp 半宽时，时间滚动回测的名义 80% 区间实际只覆盖 69.6%。
# 单次 80/20 切分只有 37 个样本外点，分位数估计噪声大；
# 滚动范围必须与真实使用场景一致（每个测试点只用它之前的样本训练），所以覆盖到全量样本，
# 而不是只覆盖训练段——只覆盖训练段会因窗口偏小把半宽系统性压低（实测 149 vs 195）。
# 覆盖率由 backtest_ipo_prediction.py 独立复核。
ROLLING_STEP = 5
rolling_start = max(80, int(n * 0.4))
rolling_errors = []
rolling_model = None
rolling_medians = None
for index in range(rolling_start, n):
    if rolling_model is None or (index - rolling_start) % ROLLING_STEP == 0:
        window_raw = {key: value[:index] for key, value in raw_fields.items()}
        rolling_medians = {field: float(np.nanmedian(window_raw[field])) for field in FITTED_MEDIAN_FIELDS}
        window_features = build_feature_matrix(window_raw, rolling_medians)
        rolling_model = xgb.train(
            XGB_PARAMS,
            xgb.DMatrix(window_features, label=symlog_return(gain[:index]), feature_names=feature_names),
            num_boost_round=NUM_BOOST_ROUND,
        )
    one_raw = {key: value[index:index + 1] for key, value in raw_fields.items()}
    one_pred = float(inv_symlog_return(rolling_model.predict(
        xgb.DMatrix(build_feature_matrix(one_raw, rolling_medians), feature_names=feature_names)
    ))[0])
    rolling_errors.append(abs(one_pred - float(gain[index])))

interval_half_width = float(np.quantile(rolling_errors, 0.8)) if rolling_errors else 0.0
print(f"区间半宽（滚动样本外 80 分位，{len(rolling_errors)} 个测试点）: {interval_half_width:.0f}pp")

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
score = model.get_score(importance_type="gain")
importance = np.array([score.get(name, 0.0) for name in feature_names])
idx_sorted = np.argsort(importance)[::-1]
for i in idx_sorted[:10]:
    print(f"  {feature_names[i]}: {importance[i]:.3f}")

# ── 5. 保存 ──
# 先写同目录临时文件再替换，避免旧模型文件由部署用户创建时无法直接覆盖。
model_fd, model_tmp = tempfile.mkstemp(prefix="ipo_xgb_model_", suffix=".json", dir=MODEL_DIR)
os.close(model_fd)
try:
    model.save_model(model_tmp)
    os.replace(model_tmp, MODEL_PATH)
except Exception:
    if os.path.exists(model_tmp):
        os.unlink(model_tmp)
    raise

info = {
    "features": feature_names,
    "medians": {k: float(v) for k, v in medians.items() if not np.isnan(v)},
    # 每个字段的缺值来源；native_missing 表示训练时保留缺失、不用 0 补位
    "fill_sources": fill_sources,
    "native_missing_features": list(NATIVE_MISSING_FIELDS),
    "sample_count": n,
    "train_mae": float(train_mae),
    "test_mae": float(test_mae),
    "train_mape": float(train_mape),
    "test_mape": float(test_mape),
    # 预测区间半宽（pp）：样本外绝对误差的 80 分位数，推理端优先使用该值
    "interval_half_width": interval_half_width,
    # 上线模型用全部样本训练；评估模型只用前 80% 训练，指标为样本外口径
    "model_trained_on": "all_samples",
    "eval_train_size": train_size,
    "eval_holdout_size": n - train_size,
    # 目标变换：symlog 保留破发（负收益）符号与量级；
    # 旧的 log1p_nonnegative_return 会把破发截断成 0，产物不再产出该口径
    "target_transform": "symlog_return",
    "trained_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
}
features_fd, features_tmp = tempfile.mkstemp(prefix="ipo_xgb_features_", suffix=".json", dir=MODEL_DIR)
os.close(features_fd)
try:
    with open(features_tmp, "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    os.replace(features_tmp, FEATURES_PATH)
except Exception:
    if os.path.exists(features_tmp):
        os.unlink(features_tmp)
    raise

print(f"\n模型已保存: {MODEL_PATH}")
print(f"特征信息已保存: {FEATURES_PATH}")
