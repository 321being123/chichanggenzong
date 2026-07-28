"""可转债估值引擎（生产版，整改后）。

复用 outputs/convertible_bond_valuation_backtest.py 的中性公允价方法：
- 价值底座 anchor = max(纯债价值, 转股价值)
- 实际额外价值 E = ln(价格 / 锚)
- 按日去除市场整体情绪，学习单券结构差异 Ri = E - 当日市场中位
- 中性市场基准 N = 历史每日市场中位 E 的中位数（按年度训练截止日固化，不随预测日变化）
- 中性公允价 F = anchor * e^(N + R_hat)
- 绝对估值偏离 D = 价格 / F - 1
- 公允区间使用历史样本外偏离分布 40%~60% 分位
- 历史估值分位 = D 在历史偏离分布中的经验分位

整改后新增的硬性规则（对应验收整改报告 P0/P1）：
- 每个历史年度使用上一年末以前的数据训练独立年度子模型；无合法年度模型时禁止回退未来模型，标记“数据不足/无可用模型”。
- 中性市场基准、误差分位、历史分位分布按对应年度训练截止日固化（yearly_metadata），不跨年度混合。
- 评级只使用估值日之前已经公告的数据（按 rating_date / announced_at 截断）。
- 历史安全性只能使用当时有效的安全性结果（bond_safety_snapshot_history）；缺失标记“历史安全性不可用”，禁止用当前快照倒填。
- 模型训练后默认不启用；必须单独 enable 且回测达标、SHA-256 一致才启用；同一时间仅一个活动模型。
- 完整可交易转债范围：历史上出现过行情的转债全部纳入，核心字段或行情缺失仍保存并标记“数据不足”。
- 历史回填不生成实时预警；每日推算可对比上一交易日生成状态跃迁预警（含方案 §12.2 全部类型 + 状态机）。
- 所有数据仅来自本地 PostgreSQL，不在推算/请求时调用 Tushare。
"""

import argparse
import bisect
import hashlib
import json
import math
import os
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
import xgboost as xgb

ROOT = Path(__file__).resolve().parents[1]
DATA_MODELS_DIR = ROOT / "data" / "models" / "convertible-bond-valuation"
FORMULA_VERSION = "cb-neutral-fair-value-v1"
FEATURE_VERSION = "cbv-feat-v1"
UNIVERSE_VERSION = "active-cb-v1"
HORIZONS = (20, 60, 120)
FEATURES = ("log_cv", "log_bv", "log_cv_bv", "remaining_years", "cv_vol60")
# 回测容差：新模型相对现有基准允许下降的幅度（方案 §22 要求不能明显低于现有模型）
BACKTEST_TOLERANCE = {"60": 0.5, "120": 1.0}  # 百分比绝对容差
EXISTING_BASELINE = {"20": 1.144, "60": 2.876, "120": 4.325}  # 方案 §22.1
EXISTING_CONVERGENCE = {"20": 2.347, "60": 4.561, "120": 6.831}  # 方案 §22.2

# 评级序数：数值越大评级越高。A+ 及以下 => rank <= 2。
_RATING_RANK = {
    "AAA": 6, "AA+": 5, "AA": 4, "AA-": 3, "A+": 2, "A": 1, "A-": 0,
    "BBB+": -1, "BBB": -2, "BB": -3, "B": -4, "C": -5, "": -99,
}

# 稳定评价分类（供统计/排序，不依赖中文完整文案）
EVAL_CLASSES = ["低估", "偏低估", "合理", "偏高估", "高估", "风险折价", "数据不足"]


def load_env():
    # .env 位于项目根目录（server/ 的上一级），与 Node 端 dotenv 读取位置一致；
    # 兼容历史放在 server/ 下的写法。setdefault 保证外部显式导出的环境变量优先。
    candidates = [ROOT.parent / ".env", ROOT / ".env"]
    env_path = next((p for p in candidates if p.exists()), None)
    if env_path is not None:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def db_connect():
    if os.environ.get("DATABASE_URL"):
        return psycopg2.connect(os.environ["DATABASE_URL"])
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "localhost"),
        port=os.environ.get("PGPORT", "5432"),
        user=os.environ.get("PGUSER"),
        password=os.environ.get("PGPASSWORD"),
        dbname=os.environ.get("PGDATABASE"),
    )


# ----------------------------------------------------------------------------
# 数据准备（保留全部历史行情行；不过滤，缺失由推算阶段判定“数据不足”）
# ----------------------------------------------------------------------------
def load_daily_facts():
    sql = """
      SELECT i.instrument_id,
             i.canonical_code AS ts_code,
             m.trade_date,
             m.close::float8 AS close,
             m.conversion_value::float8 AS conversion_value,
             m.conversion_premium_pct::float8 AS conversion_premium_pct,
             m.bond_value::float8 AS bond_value,
             p.maturity_date AS maturity_date
        FROM market.convertible_bond_daily_metrics m
        JOIN core.instruments i ON i.instrument_id = m.instrument_id
        LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = m.instrument_id
       ORDER BY i.canonical_code, m.trade_date
    """
    with db_connect() as conn:
        return pd.read_sql_query(sql, conn)


def prepare_data(facts):
    df = facts.copy()
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    df["maturity_date"] = pd.to_datetime(df["maturity_date"], errors="coerce")
    df = df.sort_values(["ts_code", "trade_date"]).reset_index(drop=True)

    df["anchor"] = df[["conversion_value", "bond_value"]].max(axis=1)
    df["log_extra_ratio"] = np.log(df["close"] / df["anchor"].replace(0, np.nan))
    df["log_cv"] = np.log(df["conversion_value"].replace(0, np.nan))
    df["log_bv"] = np.log(df["bond_value"].replace(0, np.nan))
    df["log_cv_bv"] = np.log(df["conversion_value"] / df["bond_value"].replace(0, np.nan))
    df["remaining_years"] = (df["maturity_date"] - df["trade_date"]).dt.days / 365.25

    df["cv_return"] = df.groupby("ts_code", sort=False)["conversion_value"].pct_change(fill_method=None)
    df["cv_vol60"] = (
        df.groupby("ts_code", sort=False)["cv_return"]
        .rolling(60, min_periods=40)
        .std()
        .reset_index(level=0, drop=True)
        * math.sqrt(252)
    )

    # 未来收益（仅用于回测门槛，不参与训练，无未来泄漏）
    for horizon in HORIZONS:
        future = df.groupby("ts_code", sort=False)["close"].shift(-horizon)
        future_anchor = df.groupby("ts_code", sort=False)["anchor"].shift(-horizon)
        df[f"return_{horizon}"] = future / df["close"] - 1
        df[f"anchor_return_{horizon}"] = future_anchor / df["anchor"] - 1
        df[f"anchor_adjusted_return_{horizon}"] = (
            (1 + df[f"return_{horizon}"]) / (1 + df[f"anchor_return_{horizon}"]) - 1
        )

    # 是否具备正式估值的完整特征（用于“数据不足”判定，不剔除行）
    df["has_full_features"] = (
        df[list(FEATURES)].replace([np.inf, -np.inf], np.nan).notna().all(axis=1)
        & df["close"].gt(0).fillna(False)
        & df["conversion_value"].gt(0).fillna(False)
        & df["bond_value"].gt(0).fillna(False)
        & df["remaining_years"].between(0.05, 8)
        & df["cv_vol60"].between(0, 3)
        & df["log_extra_ratio"].between(-0.5, 1.5)
    )
    # 把无穷替换为 NaN（dropna 才能剔除），训练侧据此排除无效样本
    for c in ["log_extra_ratio", "log_cv", "log_bv", "log_cv_bv"]:
        df[c] = df[c].replace([np.inf, -np.inf], np.nan)
    return df


def monthly_dates(df):
    return (
        df[["trade_date"]]
        .drop_duplicates()
        .assign(month=lambda x: x["trade_date"].dt.to_period("M"))
        .groupby("month")["trade_date"]
        .max()
        .sort_values()
        .tolist()
    )


def train_xgb(train_matrix, seed=20260727):
    params = {
        "objective": "reg:absoluteerror",
        "max_depth": 4,
        "eta": 0.05,
        "min_child_weight": 20,
        "subsample": 0.8,
        "colsample_bytree": 0.9,
        "lambda": 5,
        "nthread": 4,
        "seed": seed,
    }
    return xgb.train(params, train_matrix, num_boost_round=220)


def _stable_dates(df):
    """返回全部交易日（升序去重），用于判断“落后多少交易日”。"""
    return sorted(df["trade_date"].dt.date.unique())


def fit_predict_annual(df):
    """年度滚动训练；每个预测年使用上一年末以前的数据。

    返回 (predictions, yearly_models)，其中 yearly_models[year] = {
      booster, neutral_market_extra, residual_quantiles, training_end_date
    }。中性基准与误差分位按年度训练截止日固化。
    """
    month_ends = monthly_dates(df)
    predictions = []
    yearly_models = {}
    for year in range(2021, int(df["trade_date"].dt.year.max()) + 1):
        year_start = pd.Timestamp(year=year, month=1, day=1)
        train = df[df["trade_date"] < year_start].copy()
        train = train.dropna(subset=list(FEATURES) + ["log_extra_ratio"])
        predict_dates = [d for d in month_ends if d.year == year]
        test = df[df["trade_date"].isin(predict_dates)].copy()
        test = test.dropna(subset=list(FEATURES) + ["log_extra_ratio"])
        if train["trade_date"].nunique() < 500 or test.empty:
            continue

        daily_median = train.groupby("trade_date")["log_extra_ratio"].median()
        train["daily_median"] = train["trade_date"].map(daily_median)
        train["relative_extra"] = train["log_extra_ratio"] - train["daily_median"]
        neutral_market = float(daily_median.median())

        sampled_dates = set(sorted(train["trade_date"].unique())[::5])
        sample = train[train["trade_date"].isin(sampled_dates)].copy()
        low, high = sample["relative_extra"].quantile([0.005, 0.995])
        sample["target"] = sample["relative_extra"].clip(low, high)

        booster = train_xgb(xgb.DMatrix(sample[list(FEATURES)], label=sample["target"]))
        test = test.copy()
        test["predicted_relative_extra"] = booster.predict(xgb.DMatrix(test[list(FEATURES)]))
        test["fair_log_extra"] = neutral_market + test["predicted_relative_extra"]
        test["fair_price"] = test["anchor"] * np.exp(test["fair_log_extra"])
        test["absolute_deviation"] = test["close"] / test["fair_price"] - 1

        # 按年度训练截止日固化的误差分位（仅用本年度的样本外预测）
        dev = test["absolute_deviation"].to_numpy()
        dev = dev[np.isfinite(dev)]
        if len(dev) >= 200:
            q = np.quantile(dev, [0.20, 0.40, 0.60, 0.80, 0.95])
            edges = np.linspace(np.nanmin(dev), np.nanmax(dev), 201)
            counts, _ = np.histogram(dev, bins=edges)
            cum = np.cumsum(counts).astype(float)
            cum /= cum[-1]
            yearly_models[year] = {
                "booster": booster,
                "neutral_market_extra": round(neutral_market, 8),
                "residual_quantiles": {
                    "q20": float(q[0]), "q40": float(q[1]), "q60": float(q[2]),
                    "q80": float(q[3]), "q95": float(q[4]),
                    "hist_edges": [float(x) for x in edges],
                    "hist_cum": [float(x) for x in cum],
                    "n": int(len(dev)),
                },
                "training_end_date": train["trade_date"].max().date().isoformat(),
            }
            predictions.append(test)
    if not predictions:
        raise RuntimeError("没有产生样本外预测，无法固化模型")
    return pd.concat(predictions, ignore_index=True), yearly_models


# ----------------------------------------------------------------------------
# 模型元数据：误差分位直方图（per-year 已固化，这里仅工具函数）
# ----------------------------------------------------------------------------
def build_residual_metadata(predictions):
    dev = predictions["absolute_deviation"].to_numpy()
    dev = dev[np.isfinite(dev)]
    q = np.quantile(dev, [0.20, 0.40, 0.60, 0.80, 0.95])
    edges = np.linspace(np.nanmin(dev), np.nanmax(dev), 201)
    counts, _ = np.histogram(dev, bins=edges)
    cum = np.cumsum(counts).astype(float)
    cum /= cum[-1]
    return {
        "q20": float(q[0]), "q40": float(q[1]), "q60": float(q[2]),
        "q80": float(q[3]), "q95": float(q[4]),
        "hist_edges": [float(x) for x in edges],
        "hist_cum": [float(x) for x in cum],
        "n": int(len(dev)),
    }


def percentile_from_hist(d, meta):
    """返回 d 在历史偏离分布中的经验分位（0~100）。meta 含 hist_edges/hist_cum。"""
    edges = np.array(meta["hist_edges"])
    cum = np.array(meta["hist_cum"])
    if not np.isfinite(d):
        return None
    idx = np.searchsorted(edges, d, side="right") - 1
    idx = max(0, min(idx, len(cum) - 1))
    return round(float(cum[idx]) * 100, 1)


def base_evaluation_from_percentile(p):
    if p is None:
        return None
    if p < 20:
        return "低估"
    if p < 40:
        return "偏低估"
    if p < 60:
        return "合理"
    if p < 80:
        return "偏高估"
    return "高估"


# ----------------------------------------------------------------------------
# 截至当日（as-of）残差分布：消除年内未来泄漏
# 训练固化的年度分位仅作兜底；推算阶段按年维护累计直方图，处理到日期 D 时
# 只把 <=D 的偏离值累计进去，再用该截至 D 的分布算分位/公允区间/评价。
# ----------------------------------------------------------------------------
def _new_residual_tracker(edges):
    return {
        "edges": np.asarray(edges, dtype=float),
        "counts": np.zeros(max(1, len(edges) - 1), dtype=float),
        "total": 0.0,
    }


def _tracker_add(tr, devs):
    devs = np.asarray(devs, dtype=float)
    devs = devs[np.isfinite(devs)]
    if devs.size == 0:
        return
    c, _ = np.histogram(devs, bins=tr["edges"])
    tr["counts"] += c
    tr["total"] += devs.size


def _tracker_percentile(tr, d):
    if tr["total"] <= 0 or not np.isfinite(d):
        return None
    cum = np.cumsum(tr["counts"]) / tr["total"]
    idx = np.searchsorted(tr["edges"], d, side="right") - 1
    idx = max(0, min(idx, len(cum) - 1))
    return round(float(cum[idx]) * 100, 1)


def _tracker_quantile(tr, q):
    """返回截至当前累计分布的第 q 分位对应的偏离值（用于公允区间边界）。"""
    if tr["total"] <= 0:
        return None
    cum = np.cumsum(tr["counts"]) / tr["total"]
    idx = int(np.searchsorted(cum, q))
    idx = min(max(idx, 0), len(tr["edges"]) - 2)
    return float(tr["edges"][idx])


# ----------------------------------------------------------------------------
# 安全性与信用评级（复用现有结果，不改写公允价）
# ----------------------------------------------------------------------------
def load_safety_map():
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT data FROM bond_safety_snapshots ORDER BY id DESC LIMIT 1")
            row = cur.fetchone()
    if not row or not row[0]:
        return {}
    data = row[0] if isinstance(row[0], list) else json.loads(row[0])
    out = {}
    for rec in data:
        code = (rec.get("bond_code") or "").strip()
        if code:
            out[code] = rec.get("safety") or ""
    return out


def load_bond_profiles():
    """返回 {canonical_code: {maturity_date, conv_end_date, conv_stop_date, cb_type, stock_status, stock_delist_date}}。

    用于可交易范围判定：排除已到期 / 停止转股 / 非可转债 / 正股退市。
    """
    out = {}
    try:
        with db_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT i.canonical_code, p.maturity_date, p.conv_end_date, p.conv_stop_date, "
                    "p.cb_type, s.status AS stock_status, s.delist_date AS stock_delist_date "
                    "FROM fundamental.convertible_bond_profiles p "
                    "JOIN core.instruments i ON i.instrument_id = p.instrument_id "
                    "LEFT JOIN core.instruments s ON s.instrument_id = p.stock_instrument_id"
                )
                for row in cur.fetchall():
                    out[row[0]] = {
                        "maturity_date": row[1], "conv_end_date": row[2], "conv_stop_date": row[3],
                        "cb_type": (row[4] or "CB"), "stock_status": (row[5] or "listed"),
                        "stock_delist_date": row[6],
                    }
    except Exception:
        pass
    return out


def load_historical_safety_map(as_of):
    """取 <= as_of 的最近一份历史安全性快照；无则返回空（标记“历史安全性不可用”）。"""
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT data FROM analytics.bond_safety_snapshot_history "
                "WHERE snapshot_date <= %s ORDER BY snapshot_date DESC LIMIT 1",
                (as_of,),
            )
            row = cur.fetchone()
    if not row or not row[0]:
        return None
    data = row[0] if isinstance(row[0], list) else json.loads(row[0])
    out = {}
    for rec in data:
        code = (rec.get("bond_code") or "").strip()
        if code:
            out[code] = rec.get("safety") or ""
    return out


def load_ratings():
    sql = """
      SELECT i.canonical_code AS ts_code,
             r.rating_date, r.rating, r.rating_outlook, r.rating_type, r.raw_payload,
             r.announced_at
        FROM fundamental.convertible_bond_ratings r
        JOIN core.instruments i ON i.instrument_id = r.instrument_id
       WHERE r.rating IS NOT NULL AND r.rating <> ''
       ORDER BY i.canonical_code, r.rating_date
    """
    with db_connect() as conn:
        df = pd.read_sql_query(sql, conn)
    df["rating_date"] = pd.to_datetime(df["rating_date"], errors="coerce")
    df["announced_at"] = pd.to_datetime(df["announced_at"], errors="coerce")
    out = {}
    for code, g in df.groupby("ts_code"):
        g = g.sort_values("rating_date")
        out[code] = g
    return out


def _rank(rating):
    return _RATING_RANK.get((rating or "").strip().upper(), -99)


def evaluate_credit(code, ratings_df):
    """返回 (credit_triggered, label, latest_rating)。ratings_df 已按估值日截断。"""
    if ratings_df is None or ratings_df.empty:
        return False, "评级历史不足", ""
    latest = ratings_df.iloc[-1]
    latest_rating = str(latest["rating"]).strip()
    if len(ratings_df) < 2:
        return False, "评级历史不足", latest_rating

    triggered = False
    labels = []
    if _rank(latest_rating) <= 2:
        triggered = True
        labels.append("评级偏低")
    last_two = ratings_df.iloc[-2:]
    if _rank(last_two.iloc[-1]["rating"]) < _rank(last_two.iloc[-2]["rating"]):
        triggered = True
        labels.append("评级下调")
    last_date = pd.to_datetime(latest["rating_date"])
    window = ratings_df[ratings_df["rating_date"] >= (last_date - pd.Timedelta(days=365))]
    if len(window) >= 2 and _rank(window.iloc[-1]["rating"]) < _rank(window.iloc[0]["rating"]):
        triggered = True
        if "评级下调" not in labels:
            labels.append("评级下调")
    outlook = str(latest.get("rating_outlook") or "").strip()
    if "负面" in outlook or "消极" in outlook:
        triggered = True
        labels.append("负面展望")
    rating_type = str(latest.get("rating_type") or "")
    raw = ""
    try:
        raw = json.dumps(latest.get("raw_payload") or {}, ensure_ascii=False)
    except Exception:
        raw = ""
    if "观察" in rating_type or "观察" in raw:
        triggered = True
        labels.append("列入观察")
    seq = [_rank(x) for x in ratings_df["rating"]]
    consec = 0
    max_consec = 0
    for i in range(1, len(seq)):
        if seq[i] < seq[i - 1]:
            consec += 1
            max_consec = max(max_consec, consec)
        else:
            consec = 0
    if max_consec >= 2:
        triggered = True
        labels.append("连续下调")
    label = "、".join(labels) if labels else "无"
    return triggered, label, latest_rating


# ----------------------------------------------------------------------------
# 回测门槛（方案 §22）：三组未来收益区分 + 稳健代理 + 单年份 + 高热度
# ----------------------------------------------------------------------------
def _spread(sub, signal_col, return_col):
    sub = sub.dropna(subset=[signal_col, return_col])
    if len(sub) < 50:
        return None
    sub = sub.copy()
    sub["rank"] = sub[signal_col].rank(method="first", pct=True)
    low = sub.loc[sub["rank"] <= 0.2, return_col].mean()
    high = sub.loc[sub["rank"] > 0.8, return_col].mean()

    def _day_win(g):
        lg = g.loc[g["rank"] <= 0.2, return_col].mean()
        hg = g.loc[g["rank"] > 0.8, return_col].mean()
        return bool(lg > hg) if pd.notna(lg) and pd.notna(hg) else False

    day_win = sub.groupby("trade_date").apply(_day_win)
    win_rate = float(day_win.mean() * 100) if len(day_win) else 0.0
    return {
        "spread_pct": round(float((low - high) * 100), 3),
        "win_rate_pct": round(win_rate, 1),
        "count": int(len(sub)),
    }


def run_backtest(predictions):
    """返回回测指标与是否达标（pass）。仅使用样本外 predictions。

    门槛（方案 §22 + 复验整改）：
    - 三周期方向全部为正（总收益区分 / 扣除价值底座 / 稳健代理）。
    - 60/120 不能明显低于现有模型（容差 BACKTEST_TOLERANCE）。
    - 单一年份不能长期「完全失效」。
    - 高热度市场子区间仍须区分低估/高估（不能被模型解释为“合理”）。
    - 任一周期无结果（样本不足）判为不达标，不再静默通过。
    """
    out = {"portfolio": [], "convergence": [], "stable_agent": [], "yearly": [],
           "yearly_fail": False, "high_heat_fail": False, "missing_horizon": False, "pass": True}
    all_pred = predictions.copy()
    # 日度市场中位偏离，用于定义高热度市场子区间（按日中位偏离的 80 分位为阈值）
    all_pred["day_median"] = all_pred.groupby("trade_date")["absolute_deviation"].transform("median")
    try:
        heat_thr = float(all_pred["day_median"].quantile(0.8))
    except Exception:
        heat_thr = None
    high_heat = all_pred[all_pred["day_median"] >= heat_thr] if heat_thr is not None else all_pred.iloc[0:0]

    for horizon in HORIZONS:
        sp = _spread(all_pred, "absolute_deviation", f"return_{horizon}")
        if sp:
            out["portfolio"].append({"horizon": horizon, **sp})
            if len(high_heat):
                hh = _spread(high_heat, "absolute_deviation", f"return_{horizon}")
                if hh and hh["spread_pct"] <= 0:
                    out["pass"] = False
                    out["high_heat_fail"] = True
        cv = _spread(all_pred, "absolute_deviation", f"anchor_adjusted_return_{horizon}")
        if cv:
            out["convergence"].append({"horizon": horizon, **cv})
            if len(high_heat):
                hh_c = _spread(high_heat, "absolute_deviation", f"anchor_adjusted_return_{horizon}")
                if hh_c and hh_c["spread_pct"] <= 0:
                    out["pass"] = False
                    out["high_heat_fail"] = True
        stable = all_pred[all_pred["bond_value"] >= 85]
        sp_s = _spread(stable, "absolute_deviation", f"return_{horizon}")
        if sp_s:
            out["stable_agent"].append({"horizon": horizon, **sp_s})

    # 三周期方向全部为正（总收益区分）
    for rec in out["portfolio"]:
        if rec["spread_pct"] <= 0:
            out["pass"] = False
    # 60/120 不能明显低于现有模型（容差 BACKTEST_TOLERANCE）
    port_map = {r["horizon"]: r["spread_pct"] for r in out["portfolio"]}
    conv_map = {r["horizon"]: r["spread_pct"] for r in out["convergence"]}
    for h in (60, 120):
        if h in port_map and EXISTING_BASELINE[str(h)] - port_map[h] > BACKTEST_TOLERANCE[str(h)]:
            out["pass"] = False
        if h in conv_map and EXISTING_CONVERGENCE[str(h)] - conv_map[h] > BACKTEST_TOLERANCE[str(h)]:
            out["pass"] = False
    # 稳健代理样本方向仍为正
    for rec in out["stable_agent"]:
        if rec["spread_pct"] <= 0:
            out["pass"] = False
    # 单年份不能长期完全失效：逐年检查组合 spread 是否长期为负
    yearly = []
    for horizon in HORIZONS:
        by_year = all_pred.copy()
        by_year["yr"] = by_year["trade_date"].dt.year
        for yr, g in by_year.groupby("yr"):
            sp = _spread(g, "absolute_deviation", f"return_{horizon}")
            if sp:
                yearly.append({"year": int(yr), "horizon": horizon, **sp})
    out["yearly"] = yearly
    by_year_spreads = {}
    for y in yearly:
        by_year_spreads.setdefault(y["year"], []).append(y["spread_pct"])
    complete_fail_years = [yr for yr, sps in by_year_spreads.items() if sps and all(s <= 0 for s in sps)]
    if complete_fail_years:
        out["pass"] = False
        out["yearly_fail"] = True
        out["complete_fail_years"] = complete_fail_years
    # 某周期无结果（样本不足）判为不达标，不再静默通过
    present = {r["horizon"] for r in out["portfolio"]}
    for h in HORIZONS:
        if h not in present:
            out["pass"] = False
            out["missing_horizon"] = True
    return out


# ----------------------------------------------------------------------------
# 训练入口：固化模型版本、年度元数据、回测门槛（默认不启用）
# ----------------------------------------------------------------------------
def cmd_train():
    load_env()
    print("加载日线行情...")
    facts = load_daily_facts()
    print(f"  行情行数: {len(facts)}")
    prepared = prepare_data(facts)
    print(f"  有效样本窗口: {len(prepared)}，转债数: {prepared['ts_code'].nunique()}")

    predictions, yearly_models = fit_predict_annual(prepared)
    print(f"  样本外预测行数: {len(predictions)}，年度子模型数: {len(yearly_models)}")

    backtest = run_backtest(predictions)
    print(f"  回测达标: {backtest['pass']}")

    last_fact = prepared["trade_date"].max().date().isoformat()
    model_version = f"cb-valuation-v1-train-{last_fact.replace('-', '')}"
    version_dir = DATA_MODELS_DIR / model_version
    version_dir.mkdir(parents=True, exist_ok=True)

    # 保存年度子模型
    for year, meta in yearly_models.items():
        meta["booster"].save_model(str(version_dir / f"model_{year}.json"))

    sha = _sha256_of_dir(version_dir)

    # 年度元数据固化（仅保留序列化安全字段）
    yearly_metadata = {}
    for year, meta in yearly_models.items():
        yearly_metadata[str(year)] = {
            "neutral_market_extra": meta["neutral_market_extra"],
            "residual_quantiles": meta["residual_quantiles"],
            "training_end_date": meta["training_end_date"],
        }

    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO analytics.convertible_bond_valuation_models
                  (model_version, formula_version, feature_version, universe_version,
                   training_start_date, training_end_date, training_row_count, training_bond_count,
                   neutral_market_extra, residual_quantiles, model_path, model_file_rel_path,
                   model_sha256, backtest_metrics, is_active, yearly_metadata, created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, false, %s, now())
                ON CONFLICT (model_version) DO UPDATE SET
                  formula_version=EXCLUDED.formula_version,
                  feature_version=EXCLUDED.feature_version,
                  universe_version=EXCLUDED.universe_version,
                  training_start_date=EXCLUDED.training_start_date,
                  training_end_date=EXCLUDED.training_end_date,
                  training_row_count=EXCLUDED.training_row_count,
                  training_bond_count=EXCLUDED.training_bond_count,
                  neutral_market_extra=EXCLUDED.neutral_market_extra,
                  residual_quantiles=EXCLUDED.residual_quantiles,
                  model_path=EXCLUDED.model_path,
                  model_file_rel_path=EXCLUDED.model_file_rel_path,
                  model_sha256=EXCLUDED.model_sha256,
                  backtest_metrics=EXCLUDED.backtest_metrics,
                  yearly_metadata=EXCLUDED.yearly_metadata,
                  is_active=false,
                  activated_at=NULL,
                  enabled_by=NULL
                """,
                (
                    model_version, FORMULA_VERSION, FEATURE_VERSION, UNIVERSE_VERSION,
                    prepared["trade_date"].min().date().isoformat(), last_fact,
                    int(len(prepared)), int(prepared["ts_code"].nunique()),
                    float(np.median([m["neutral_market_extra"] for m in yearly_models.values()])),
                    json.dumps({}, ensure_ascii=False),
                    str(version_dir), str(version_dir.relative_to(ROOT)),
                    sha, json.dumps(backtest, ensure_ascii=False),
                    json.dumps(yearly_metadata, ensure_ascii=False),
                ),
            )
    print(f"模型版本已固化（默认未启用，需回测达标后 enable）: {model_version}")
    if not backtest["pass"]:
        print("  ⚠️ 回测未达方案 §22 门槛，禁止启用。请检查模型或数据。")
    return model_version, backtest["pass"]


def _sha256_of_dir(d: Path):
    h = hashlib.sha256()
    for f in sorted(d.glob("*.json")):
        h.update(f.read_bytes())
    return h.hexdigest()


def cmd_enable(version, by="admin"):
    """启用指定模型版本（同事务停用旧模型）；校验 SHA-256 与回测达标。"""
    load_env()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT model_path, model_file_rel_path, model_sha256, backtest_metrics, is_active "
                "FROM analytics.convertible_bond_valuation_models WHERE model_version=%s",
                (version,),
            )
            row = cur.fetchone()
            if not row:
                raise RuntimeError(f"模型版本不存在: {version}")
            rel_path, sha_db, backtest_json, is_active = row[1], row[2], row[3], row[4]
            backtest = backtest_json if isinstance(backtest_json, dict) else json.loads(backtest_json or "{}")
            if not backtest.get("pass"):
                raise RuntimeError(f"模型 {version} 回测未达标，禁止启用")
            model_dir = ROOT / rel_path if rel_path else Path(row[0])
            if not model_dir.exists():
                raise RuntimeError(f"模型文件不存在: {model_dir}")
            sha_now = _sha256_of_dir(model_dir)
            if sha_now != sha_db:
                raise RuntimeError(f"模型文件 SHA-256 不一致（db={sha_db[:8]} now={sha_now[:8]}），拒绝启用")
            cur.execute(
                "UPDATE analytics.convertible_bond_valuation_models SET is_active=false, disabled_at=now() "
                "WHERE is_active=true AND model_version<>%s", (version,)
            )
            cur.execute(
                "UPDATE analytics.convertible_bond_valuation_models SET is_active=true, activated_at=now(), enabled_by=%s "
                "WHERE model_version=%s", (by, version)
            )
            conn.commit()
    print(f"模型已启用: {version}（by={by}）")


# ----------------------------------------------------------------------------
# 推算单日估值
# ----------------------------------------------------------------------------
def _load_active_model():
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT model_version, model_file_rel_path, model_sha256, yearly_metadata "
                "FROM analytics.convertible_bond_valuation_models WHERE is_active=true ORDER BY created_at DESC LIMIT 1"
            )
            row = cur.fetchone()
    if not row:
        return None
    rel_path = row[1] or row[0]
    model_dir = ROOT / rel_path
    sha_db = row[2]
    if not model_dir.exists():
        raise RuntimeError(f"活动模型文件不存在: {model_dir}")
    sha_now = _sha256_of_dir(model_dir)
    if sha_now != sha_db:
        raise RuntimeError(f"活动模型 SHA-256 不一致（db={sha_db[:8]} now={sha_now[:8]}），拒绝推算")
    yearly = row[3] if row[3] else {}
    return {
        "model_version": row[0],
        "model_path": str(model_dir),
        "yearly": yearly,
    }


def _booster_for_date(model_path, trade_year):
    """取 <= 预测年 的最近一个年度子模型（禁止回退未来模型）。无合法模型返回 None。"""
    base = Path(model_path)
    candidates = sorted([int(p.stem.split("_")[1]) for p in base.glob("model_*.json") if p.stem.startswith("model_")])
    usable = [y for y in candidates if y <= trade_year]
    if not usable:
        return None, None
    year = max(usable)
    booster = xgb.Booster()
    booster.load_model(str(base / f"model_{year}.json"))
    return booster, year


def _ratings_as_of(ratings_map, code, as_of_ts):
    g = ratings_map.get(code)
    if g is None or g.empty:
        return None
    # 评级只使用估值日之前已经公告的数据（rating_date 与 announced_at 均 <= as_of）
    mask = pd.Series(True, index=g.index)
    if "rating_date" in g:
        mask &= g["rating_date"].dt.normalize() <= as_of_ts.normalize()
    if "announced_at" in g and g["announced_at"].notna().any():
        mask &= g["announced_at"].dt.normalize() <= as_of_ts.normalize()
    sub = g[mask]
    return sub if not sub.empty else None


def compute_daily(trade_date_iso, prepared, model, full_universe, safety_map, ratings_map,
                  generate_alerts=False, is_historical=False, index=None, profile_map=None,
                  residual_trackers=None):
    target = pd.Timestamp(trade_date_iso)
    if index is None:
        day_index, by_code_dates, by_code_rows = _build_index(prepared)
    else:
        day_index, by_code_dates, by_code_rows = index

    results = []

    booster, model_year = _booster_for_date(model["model_path"], target.year)
    year_meta = (model["yearly"].get(str(model_year)) or model["yearly"].get(model_year)) if booster is not None else None
    if booster is None or not year_meta:
        reason = "无可用年度模型(禁止回退未来)" if booster is None else "年度元数据缺失"
        univ = _universe_as_of(by_code_dates, profile_map, target, 7) or list(full_universe)
        for code in univ:
            base_code = code.split(".")[0]
            rr = by_code_rows.get(code)
            r0 = rr[bisect.bisect_right(by_code_dates[code], target) - 1] if rr else None
            results.append(_insufficient_row(target, code, r0, reason, is_historical, safety_map, base_code, None, no_model=(booster is None), mv=model["model_version"]))
        with db_connect() as conn:
            _persist_daily(results, conn)
            if generate_alerts:
                _generate_alerts(results, conn)
        return len([r for r in results if r.get("data_status") in ("完整", "行情非当日")]), []

    neutral = float(year_meta["neutral_market_extra"])
    valid, insufficient = _collect_valid(prepared, model, target, index, profile_map)
    for (code, base_code, r, reason) in insufficient:
        results.append(_insufficient_row(target, code, r, reason, is_historical, safety_map, base_code, None, mv=model["model_version"]))

    if valid:
        X = np.array([v["r"][list(FEATURES)].to_numpy(dtype=float) for v in valid], dtype=float)
        pred_rel_arr = booster.predict(xgb.DMatrix(X, feature_names=list(FEATURES)))
        day_devs = []
        for k, v in enumerate(valid):
            pred_rel = float(pred_rel_arr[k])
            r = v["r"]
            fair = float(r["anchor"] * np.exp(neutral + pred_rel))
            dev = float(r["close"] / fair - 1)
            v["pred_rel"] = pred_rel
            v["fair"] = fair
            v["dev"] = dev
            day_devs.append(dev)
        # 更新截至当日（as-of）残差分布（消除年内未来泄漏）
        if residual_trackers is not None:
            if model_year not in residual_trackers:
                residual_trackers[model_year] = _new_residual_tracker(year_meta["residual_quantiles"]["hist_edges"])
            _tracker_add(residual_trackers[model_year], day_devs)
        for v in valid:
            pred_rel = v["pred_rel"]; fair = v["fair"]; dev = v["dev"]
            code = v["code"]; base_code = v["base_code"]; r = v["r"]; lag = v["lag"]
            # 分位/公允区间：优先 as-of 截至当日分布，回退年度固化分位
            if residual_trackers is not None and residual_trackers.get(model_year) and residual_trackers[model_year]["total"] > 0:
                tr = residual_trackers[model_year]
                pct = _tracker_percentile(tr, dev)
                q40 = _tracker_quantile(tr, 0.40)
                q60 = _tracker_quantile(tr, 0.60)
                fair_low = round(fair * (1 + q40), 2) if q40 is not None else None
                fair_high = round(fair * (1 + q60), 2) if q60 is not None else None
            else:
                residual = year_meta["residual_quantiles"]
                pct = percentile_from_hist(dev, residual)
                fair_low = round(fair * (1 + residual["q40"]), 2)
                fair_high = round(fair * (1 + residual["q60"]), 2)
            base_eval = base_evaluation_from_percentile(pct)
            ratings_sub = _ratings_as_of(ratings_map, code, target)
            credit_triggered, credit_label, latest_rating = evaluate_credit(code, ratings_sub)
            if is_historical:
                hist_safety = (safety_map or {}).get(base_code, "")
                safety = hist_safety if hist_safety else "历史安全性不可用"
                hist_safety_col = safety
            else:
                safety = safety_map.get(base_code, "")
                hist_safety_col = None
            # 安全性缺失不再强归“数据不足”：保留百分位评价，仅标注参考
            if not safety or safety in ("未评级", "历史安全性不可用"):
                eval_class = base_eval if base_eval else "数据不足"
                safety_missing = True
            else:
                eval_class = base_eval if base_eval else "数据不足"
                safety_missing = False
            final = _final_evaluation(base_eval, safety, credit_triggered)
            results.append({
                "trade_date": target.date().isoformat(),
                "instrument_id": int(r["instrument_id"]),
                "model_version": model["model_version"],
                "model_year": int(model_year),
                "formula_version": FORMULA_VERSION,
                "feature_version": FEATURE_VERSION,
                "universe_version": UNIVERSE_VERSION,
                "quote_date": r["trade_date"].date().isoformat(),
                "quote_lag_days": int(lag),
                "close": round(float(r["close"]), 2),
                "conversion_value": round(float(r["conversion_value"]), 2),
                "bond_value": round(float(r["bond_value"]), 2),
                "conversion_premium_pct": round(float(r["conversion_premium_pct"]), 2) if pd.notna(r["conversion_premium_pct"]) else None,
                "anchor_value": round(float(r["anchor"]), 2),
                "remaining_years": round(float(r["remaining_years"]), 2),
                "conversion_value_volatility_60d": round(float(r["cv_vol60"]) * 100, 2) if pd.notna(r["cv_vol60"]) else None,
                "neutral_market_extra": round(neutral, 6),
                "predicted_relative_extra": round(pred_rel, 6),
                "fair_price": round(fair, 2),
                "fair_price_low": fair_low,
                "fair_price_high": fair_high,
                "absolute_deviation_pct": round(dev * 100, 2),
                "valuation_percentile": pct,
                "market_heat_pct": None,
                "relative_market_deviation_pct": None,
                "base_evaluation": base_eval or "",
                "eval_class": eval_class,
                "safety_level": safety if not is_historical else "",
                "historical_safety": hist_safety_col,
                "credit_warning": credit_label,
                "final_evaluation": final,
                "confidence_level": "正常" if not safety_missing else "参考(安全性缺失)",
                "data_status": "完整" if lag == 0 else "行情非当日",
                "diagnostics": json.dumps({"model_year": int(model_year), "quote_lag_days": int(lag), "safety_missing": safety_missing}, ensure_ascii=False),
                "calculated_at": "now()",
            })

    # 计算当日市场热度（仅用完整估值行的偏离中位数）
    devs = [row["absolute_deviation_pct"] / 100.0 for row in results if row.get("absolute_deviation_pct") is not None]
    heat = float(np.median(devs)) if devs else 0.0
    for row in results:
        if row.get("absolute_deviation_pct") is not None:
            row["market_heat_pct"] = round(heat * 100, 2)
            row["relative_market_deviation_pct"] = round((row["absolute_deviation_pct"] / 100.0 - heat) * 100, 2)

    with db_connect() as conn:
        _persist_daily(results, conn)
        if generate_alerts:
            _generate_alerts(results, conn)
    return len([r for r in results if r.get("data_status") in ("完整", "行情非当日")]), []


def _insufficient_row(target, code, r, reason, is_historical, safety_map, base_code, lag, no_model=False, mv=""):
    if r is not None:
        instr_id = int(r["instrument_id"])
        close = round(float(r["close"]), 2) if pd.notna(r.get("close")) else None
        cv = round(float(r["conversion_value"]), 2) if pd.notna(r.get("conversion_value")) else None
        bv = round(float(r["bond_value"]), 2) if pd.notna(r.get("bond_value")) else None
        anchor = round(float(r["anchor"]), 2) if pd.notna(r.get("anchor")) else None
        quote_date = r["trade_date"].date().isoformat()
    else:
        instr_id = None
        close = cv = bv = anchor = None
        quote_date = None
    status = "无可用模型" if no_model else "数据不足"
    return {
        "trade_date": target.date().isoformat(),
        "instrument_id": instr_id,
        "model_version": mv,
        "model_year": None,
        "formula_version": FORMULA_VERSION,
        "feature_version": FEATURE_VERSION,
        "universe_version": UNIVERSE_VERSION,
        "quote_date": quote_date,
        "quote_lag_days": int(lag) if lag else None,
        "close": close,
        "conversion_value": cv,
        "bond_value": bv,
        "conversion_premium_pct": None,
        "anchor_value": anchor,
        "remaining_years": None,
        "conversion_value_volatility_60d": None,
        "neutral_market_extra": None,
        "predicted_relative_extra": None,
        "fair_price": None,
        "fair_price_low": None,
        "fair_price_high": None,
        "absolute_deviation_pct": None,
        "valuation_percentile": None,
        "market_heat_pct": None,
        "relative_market_deviation_pct": None,
        "base_evaluation": "",
        "eval_class": status,
        "safety_level": "" if not is_historical else "",
        "historical_safety": "历史安全性不可用" if is_historical else None,
        "credit_warning": "",
        "final_evaluation": status,
        "confidence_level": "低",
        "data_status": status,
        "diagnostics": json.dumps({"missing": reason, "missing_fields": [x.strip() for x in reason.split(":", 1)[-1].split(",")] if ":" in reason else []}, ensure_ascii=False),
        "calculated_at": "now()",
    }


def _final_evaluation(base_eval, safety, credit_triggered):
    if base_eval is None:
        return "数据不足"
    if not safety or safety == "未评级" or safety == "历史安全性不可用":
        return "估值结果仅供参考，安全性数据不足"
    if safety == "安全" or safety == "低风险":
        final = base_eval
    elif safety == "中风险":
        final = base_eval + "，但需关注安全性" if base_eval in ("低估", "偏低估") else base_eval
    elif safety == "高风险":
        if base_eval in ("低估", "偏低估"):
            return "风险折价，不认定为低估"
        if base_eval == "合理":
            return "估值合理，但安全性高风险"
        return base_eval + "且安全性高风险"
    else:
        final = base_eval
    if credit_triggered:
        if base_eval in ("低估", "偏低估"):
            return "风险折价"
        final = base_eval + "，信用风险提示"
    return final


def _persist_daily(rows, conn):
    if not rows:
        return
    cols = [
        "trade_date", "instrument_id", "model_version", "model_year", "formula_version", "feature_version",
        "universe_version", "quote_date", "quote_lag_days", "close", "conversion_value", "bond_value",
        "conversion_premium_pct", "anchor_value", "remaining_years",
        "conversion_value_volatility_60d", "neutral_market_extra", "predicted_relative_extra",
        "fair_price", "fair_price_low", "fair_price_high", "absolute_deviation_pct",
        "valuation_percentile", "market_heat_pct", "relative_market_deviation_pct",
        "base_evaluation", "eval_class", "safety_level", "historical_safety", "credit_warning",
        "final_evaluation", "confidence_level", "data_status", "diagnostics", "calculated_at",
    ]
    placeholders = ", ".join(["%s"] * len(cols))
    col_sql = ", ".join(cols)
    update_cols = [c for c in cols if c not in ("trade_date", "instrument_id", "model_version")]
    update_sql = ", ".join([f"{c}=EXCLUDED.{c}" for c in update_cols])
    sql = f"""
      INSERT INTO analytics.convertible_bond_valuation_daily ({col_sql}) VALUES ({placeholders})
      ON CONFLICT (trade_date, instrument_id, model_version) DO UPDATE SET {update_sql}
    """
    with conn.cursor() as cur:
        ids = []
        for r in rows:
            # instrument_id 为 NOT NULL；无行情的“数据不足”行（无 instrument_id）跳过，不落库
            if r.get("instrument_id") is None:
                continue
            cur.execute(sql, [r.get(c) for c in cols])
            ids.append(r["instrument_id"])
        # 清理当日已不在可交易范围内的旧行（如已到期/停止转股的券），避免重算后残留
        if ids:
            cur.execute(
                "DELETE FROM analytics.convertible_bond_valuation_daily "
                "WHERE trade_date=%s AND model_version=%s AND NOT (instrument_id = ANY(%s))",
                (rows[0]["trade_date"], rows[0].get("model_version"), ids),
            )
    conn.commit()


# ----------------------------------------------------------------------------
# 预警：状态跃迁检测 + 状态机（活动/恢复/解除/再触发）
# ----------------------------------------------------------------------------
HIGH_HEAT_CYCLES = ("高位", "过热")  # 市场周期表中视为"高热度"的档位


def _alert_state_of(row, prev_row=None, market_cycle=None):
    """根据当日估值行返回各预警类型的目标状态（normal 表示无需预警）。

    状态值必须是稳定的档位标识（不含每日分位等易变细节），否则同一状态会因
    数值微小波动而每天重复生成预警。
    """
    states = {}
    pct = row.get("valuation_percentile")
    safety = row.get("safety_level") or ""
    final = row.get("final_evaluation") or ""
    credit = row.get("credit_warning") or ""
    # 高位（状态值仅含档位，不含每日分位）
    if pct is not None:
        if pct >= 95:
            states["估值进入极端高位"] = "p95"
        elif pct >= 80:
            states["估值进入高位"] = "p80"
        elif pct < 20:
            states["估值进入低位"] = "p20"
    # 风险折价
    if final.startswith("风险折价"):
        states["风险折价"] = "风险折价"
    # 安全性恶化：仅当相对上一交易日档位真正下降、且落入中/高风险时触发
    if safety in ("中风险", "高风险"):
        prev_safety = (prev_row or {}).get("safety") or ""
        # 上一交易日安全档位未知（历史回填留空/首跑）时不判恶化，避免伪触发
        if prev_row is not None and prev_safety and _safety_rank(safety) > _safety_rank(prev_safety):
            states["安全性恶化"] = safety
    # 信用评级下调 / 负面展望 / 观察
    if "评级下调" in credit:
        states["信用评级下调"] = "下调"
    if "负面展望" in credit:
        states["负面评级展望"] = "负面"
    if "列入观察" in credit:
        states["评级观察名单"] = "观察"
    # 市场与单券双高：市场周期处于高热度档位 且 单券分位>=80
    if pct is not None and pct >= 80 and market_cycle in HIGH_HEAT_CYCLES:
        states["市场与单券双高"] = "双高"
    # 数据不足
    if row.get("data_status") in ("数据不足", "无可用模型"):
        states["数据不足"] = row["data_status"]
    return states


LEVEL_OF = {
    "估值进入高位": "关注", "估值进入极端高位": "重要", "估值脱离高位": "信息",
    "估值进入低位": "关注", "风险折价": "重要", "安全性恶化": "重要",
    "信用评级下调": "重要", "负面评级展望": "重要", "评级观察名单": "重要",
    "市场与单券双高": "关注", "数据不足": "重要", "数据过期": "重要",
}


def _generate_alerts(rows, conn):
    trade_date = rows[0]["trade_date"]
    with conn.cursor() as cur:
        # 上一交易日快照（首跑无历史时仅影响"恢复/解除"判定，仍应生成绝对状态预警）
        cur.execute(
            "SELECT trade_date FROM analytics.convertible_bond_valuation_daily "
            "WHERE trade_date < %s ORDER BY trade_date DESC LIMIT 1", (trade_date,)
        )
        prev = cur.fetchone()
        prev_map = {}
        if prev:
            prev_date = prev[0].isoformat() if hasattr(prev[0], "isoformat") else str(prev[0])
            cur.execute(
                "SELECT instrument_id, eval_class, valuation_percentile, safety_level, data_status, final_evaluation, model_version "
                "FROM analytics.convertible_bond_valuation_daily WHERE trade_date=%s",
                (prev_date,),
            )
            prev_map = {r[0]: {"eval": r[1], "pct": r[2], "safety": r[3], "status": r[4], "final": r[5], "mv": r[6]} for r in cur.fetchall()}
        # 最新行情日（用于数据过期判断）
        cur.execute("SELECT MAX(trade_date) FROM market.convertible_bond_daily_metrics")
        latest_market = cur.fetchone()[0]
        latest_market_str = latest_market.isoformat() if latest_market else ""
        # 当日市场周期档位（双高预警依据）
        cur.execute(
            "SELECT cycle_level FROM analytics.convertible_bond_cycle_daily WHERE trade_date=%s",
            (trade_date,),
        )
        cyc = cur.fetchone()
        market_cycle = cyc[0] if cyc else None

        for r in rows:
            iid = r["instrument_id"]
            if iid is None:
                continue
            prev_row = prev_map.get(iid)
            prev_states = _prev_active_states(cur, iid, trade_date, r.get("model_version"))
            target_states = _alert_state_of(r, prev_row=prev_row, market_cycle=market_cycle)
            # 数据过期（估值日落后最新行情日）
            if r.get("data_status") == "完整" and latest_market_str and r["trade_date"] < latest_market_str:
                target_states["数据过期"] = r["trade_date"]
            _apply_alert_state_machine(cur, iid, trade_date, r, target_states, prev_states, prev_row)
        conn.commit()


def _prev_active_states(cur, iid, trade_date, model_version):
    cur.execute(
        "SELECT alert_type, current_state FROM analytics.convertible_bond_valuation_alerts "
        "WHERE instrument_id=%s AND is_active AND (model_version=%s OR model_version IS NULL)",
        (iid, model_version),
    )
    return {(row[0], row[1]) for row in cur.fetchall()}


def _apply_alert_state_machine(cur, iid, trade_date, row, target_states, prev_states, prev_row):
    mv = row.get("model_version")
    for atype, cur_state in target_states.items():
        key = (atype, cur_state)
        if key in prev_states:
            continue  # 状态不变，不重复生成
        # 解除旧的同类型 active 预警
        cur.execute(
            "UPDATE analytics.convertible_bond_valuation_alerts SET is_active=false, resolved_at=now() "
            "WHERE instrument_id=%s AND alert_type=%s AND is_active",
            (iid, atype),
        )
        cur.execute(
            """
            INSERT INTO analytics.convertible_bond_valuation_alerts
              (instrument_id, trade_date, alert_type, alert_level, previous_state,
               current_state, trigger_payload, model_version, is_active, created_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s, true, now())
            """,
            (iid, trade_date, atype, LEVEL_OF.get(atype, "关注"), prev_row.get("eval") if prev_row else "",
             cur_state, json.dumps({"valuation_percentile": row.get("valuation_percentile")}, ensure_ascii=False), mv),
        )
    # 恢复：之前 active 的类型，现在目标状态为 normal（不在 target_states）→ 生成恢复记录并解除
    for (atype, pstate) in list(prev_states):
        if atype not in target_states:
            cur.execute(
                "UPDATE analytics.convertible_bond_valuation_alerts SET is_active=false, resolved_at=now() "
                "WHERE instrument_id=%s AND alert_type=%s AND is_active",
                (iid, atype),
            )
            # 恢复记录本身是终态通知，不保持活动状态，避免下个交易日再生成"恢复的恢复"
            cur.execute(
                """
                INSERT INTO analytics.convertible_bond_valuation_alerts
                  (instrument_id, trade_date, alert_type, alert_level, previous_state,
                   current_state, trigger_payload, model_version, is_active, created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s, false, now())
                """,
                (iid, trade_date, atype + "（恢复）", "信息", pstate, "恢复",
                 json.dumps({}, ensure_ascii=False), mv),
            )



# ----------------------------------------------------------------------------
# 推算 / 回填命令
# ----------------------------------------------------------------------------
def _build_prepared():
    load_env()
    facts = load_daily_facts()
    return prepare_data(facts)


def _full_universe(prepared):
    return list(prepared["ts_code"].unique())


def _build_index(prepared):
    """构建一次性的逐日 / 逐券索引，避免 compute_daily 每个交易日都对全量行情做扫描。

    - day_index:     {trade_date(python date): {ts_code: row(Series)}}
    - by_code_dates: {ts_code: [Timestamp, ...]}  升序（prepared 已按 ts_code,trade_date 排序）
    - by_code_rows:  {ts_code: [row(Series), ...]}  与 by_code_dates 一一对齐
    """
    day_index = {}
    by_code_dates = {}
    by_code_rows = {}
    for _, row in prepared.iterrows():
        d = row["trade_date"]
        dk = d.date() if hasattr(d, "date") else d
        code = row["ts_code"]
        day_index.setdefault(dk, {})[code] = row
        by_code_dates.setdefault(code, []).append(d)
        by_code_rows.setdefault(code, []).append(row)
    return day_index, by_code_dates, by_code_rows


def _safety_rank(s):
    """安全性档位序数：数值越大越危险。缺失按最安全处理。"""
    return {"安全": 0, "低风险": 1, "中风险": 2, "高风险": 3}.get(s, 0)


def _market_cycle_for(trade_date, cycle_map=None):
    """返回估值日的市场周期档位（如 '高位'/'过热'）。优先用预加载的 cycle_map。"""
    if cycle_map is not None:
        return cycle_map.get(str(trade_date)) or cycle_map.get(trade_date)
    try:
        with db_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT cycle_level FROM analytics.convertible_bond_cycle_daily "
                    "WHERE trade_date=%s ORDER BY trade_date DESC LIMIT 1", (trade_date,)
                )
                row = cur.fetchone()
        return row[0] if row else None
    except Exception:
        return None


def _collect_valid(prepared, model, target, index, profile_map=None):
    """返回 (valid, insufficient)。

    valid:  [{code, base_code, r, lag}] —— 具备完整特征且落在可交易范围内的转债。
    insufficient: [(code, base_code, r_or_None, reason)] —— 无行情/超 lag/核心字段缺失/不可交易。
    """
    target = pd.Timestamp(target)
    if index is None:
        day_index, by_code_dates, by_code_rows = _build_index(prepared)
    else:
        day_index, by_code_dates, by_code_rows = index
    univ = _universe_as_of(by_code_dates, profile_map, target, 7)
    if not univ:
        univ = list(_full_universe(prepared))
    day_map = day_index.get(target.date(), {})
    valid = []
    insufficient = []
    for code in univ:
        base_code = code.split(".")[0]
        r = None
        lag = 0
        if code in day_map:
            r = day_map[code]
        else:
            rows = by_code_rows.get(code)
            if not rows:
                insufficient.append((code, base_code, None, "无有效行情"))
                continue
            i = bisect.bisect_right(by_code_dates[code], target) - 1
            if i < 0:
                insufficient.append((code, base_code, None, "无有效行情"))
                continue
            r = rows[i]
            lag = (target - r["trade_date"]).days
            if lag > 7:
                insufficient.append((code, base_code, None, "超过5个交易日无有效行情"))
                continue
        missing = []
        for col, label in [("close", "价格"), ("conversion_value", "转股价值"), ("bond_value", "纯债价值"),
                           ("remaining_years", "剩余年限"), ("cv_vol60", "60日波动率")]:
            v = r.get(col)
            if v is None or (isinstance(v, float) and (np.isnan(v) or np.isinf(v))):
                missing.append(label)
            elif col in ("close", "conversion_value", "bond_value") and float(v) <= 0:
                missing.append(label)
        if missing:
            insufficient.append((code, base_code, r, "核心字段缺失:" + ",".join(missing)))
            continue
        valid.append({"code": code, "base_code": base_code, "r": r, "lag": lag})
    return valid, insufficient


def _devs_for_date(date_iso, prepared, model, index, profile_map, booster=None, neutral=None):
    """返回指定日有效转债的偏离值列表（用于预填截至当日残差分布）。
    booster/neutral 可由调用方预加载后传入，避免每个交易日重复读盘。"""
    target = pd.Timestamp(date_iso)
    valid, _ = _collect_valid(prepared, model, target, index, profile_map)
    if not valid:
        return []
    if booster is None or neutral is None:
        booster, model_year = _booster_for_date(model["model_path"], target.year)
        if booster is None:
            return []
        year_meta = (model["yearly"].get(str(model_year)) or model["yearly"].get(model_year))
        if not year_meta:
            return []
        neutral = float(year_meta["neutral_market_extra"])
    X = np.array([v["r"][list(FEATURES)].to_numpy(dtype=float) for v in valid], dtype=float)
    pred_rel_arr = booster.predict(xgb.DMatrix(X, feature_names=list(FEATURES)))
    devs = []
    for k, v in enumerate(valid):
        r = v["r"]
        fair = float(r["anchor"] * np.exp(neutral + float(pred_rel_arr[k])))
        devs.append(float(r["close"] / fair - 1))
    return devs


def _prefill_trackers(prepared, model, target, index, profile_map):
    """为单日推算预填"截至当日"残差分布：把估值日所在年份、严格早于估值日的所有
    交易日的偏离累计进 tracker，使最新交易日的分位/公允区间基于真实历史而非未来。"""
    target = pd.Timestamp(target)
    booster, model_year = _booster_for_date(model["model_path"], target.year)
    if booster is None:
        return {}
    year_meta = (model["yearly"].get(str(model_year)) or model["yearly"].get(model_year))
    if not year_meta:
        return {}
    neutral = float(year_meta["neutral_market_extra"])
    trackers = {model_year: _new_residual_tracker(year_meta["residual_quantiles"]["hist_edges"])}
    tr = trackers[model_year]
    dates = sorted({d for d in prepared["trade_date"].dt.date if d.year == target.year and d < target.date()})
    for d in dates:
        _tracker_add(tr, _devs_for_date(d.isoformat(), prepared, model, index, profile_map,
                                        booster=booster, neutral=neutral))
    return trackers


def _universe_as_of(by_code_dates, profile_map, target, within=7):
    """完整可交易范围：估值日当天或最近 <=within 个日历日内有行情，且满足：
      - 未到期（到期日 >= 估值日）
      - 未停止转股（转股截止日 >= 估值日）
      - 转债类型为可转债（cb_type == 'CB'，排除可交换债等）
      - 正股未退市（status == 'listed' 且 delist_date >= 估值日）
    对每只转债用二分查找其最近一次 <=target 的行情日，复杂度 O(券数 x log)。
    """
    target_ts = pd.Timestamp(target)
    cutoff = target_ts - pd.Timedelta(days=within)
    out = []
    for code, dlist in by_code_dates.items():
        i = bisect.bisect_right(dlist, target_ts) - 1
        if i < 0 or dlist[i] < cutoff:
            continue
        prof = profile_map.get(code) if profile_map else None
        if prof:
            td = prof.get("maturity_date")
            ce = prof.get("conv_end_date")
            cs = prof.get("conv_stop_date")
            if td and pd.Timestamp(td) < target_ts:
                continue
            if ce and pd.Timestamp(ce) < target_ts:
                continue
            if cs and pd.Timestamp(cs) < target_ts:
                continue
            if prof.get("cb_type") not in ("CB", "", None):
                continue
            stock_status = prof.get("stock_status")
            stock_delist = prof.get("stock_delist_date")
            if stock_status and stock_status != "listed":
                continue
            if stock_delist and pd.Timestamp(stock_delist) < target_ts:
                continue
        out.append(code)
    return out



def cmd_calculate(trade_date=None, with_alerts=False):
    load_env()
    prepared = _build_prepared()
    index = _build_index(prepared)
    model = _load_active_model()
    if not model:
        raise RuntimeError("尚未启用估值模型，请先运行 train 并 enable")
    safety_map = load_safety_map()
    ratings_map = load_ratings()
    profile_map = load_bond_profiles()
    full = _full_universe(prepared)
    if not trade_date:
        trade_date = prepared["trade_date"].max().date().isoformat()
    # 预填"截至当日"残差分布：单日推算也不使用当年未来数据
    trackers = _prefill_trackers(prepared, model, trade_date, index, profile_map)
    n, _ = compute_daily(trade_date, prepared, model, full, safety_map, ratings_map,
                         generate_alerts=with_alerts, is_historical=False, index=index,
                         profile_map=profile_map, residual_trackers=trackers)
    print(f"已推算 {trade_date}：{n} 只转债完成正式估值（完整可交易范围 {len(full)} 只）")
    return n


def cmd_backfill(start="2021-01-01", end=None):
    load_env()
    prepared = _build_prepared()
    index = _build_index(prepared)
    model = _load_active_model()
    if not model:
        raise RuntimeError("尚未启用估值模型，请先运行 train 并 enable")
    safety_map = load_historical_safety_map(prepared["trade_date"].max().date().isoformat()) or {}
    ratings_map = load_ratings()
    profile_map = load_bond_profiles()
    full = _full_universe(prepared)
    dates = sorted(set(d.isoformat() for d in prepared["trade_date"].dt.date))
    dates = [d for d in dates if d >= start and (end is None or d <= end)]
    total = 0
    last_ok = None
    trackers = {}  # 按年累计的"截至当日"残差分布，随日期顺推自然滚动
    for d in dates:
        # 历史安全性快照按当日查找
        hist = load_historical_safety_map(d) or {}
        n, _ = compute_daily(d, prepared, model, full, hist, ratings_map,
                             generate_alerts=False, is_historical=True, index=index,
                             profile_map=profile_map, residual_trackers=trackers)
        total += n
        last_ok = d
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE ops.sync_cursors SET last_success_date=%s "
                "WHERE scope_key='convertible_bond_valuation' AND dataset_code='daily_valuation'",
                (last_ok,),
            )
        conn.commit()
    print(f"历史回填完成：{len(dates)} 个交易日，合计 {total} 只正式估值（不生成实时预警）")


def cmd_refresh():
    """每日推算最新交易日并生成预警（由管理员在 Web 端触发，对应 POST /api/bond-valuation/refresh）。"""
    return cmd_calculate(with_alerts=True)


def main():
    parser = argparse.ArgumentParser(description="可转债估值引擎")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("train", help="训练并固化模型版本（默认不启用）")
    p_en = sub.add_parser("enable", help="启用已训练且回测达标的模型版本")
    p_en.add_argument("version", help="model_version")
    p_en.add_argument("--by", default="admin")
    p_calc = sub.add_parser("calculate", help="推算某日（默认最新）估值")
    p_calc.add_argument("--date", default=None)
    p_calc.add_argument("--alerts", action="store_true", help="生成状态跃迁预警")
    p_back = sub.add_parser("backfill", help="历史回填（不生成预警）")
    p_back.add_argument("--start", default="2021-01-01")
    p_back.add_argument("--end", default=None)
    sub.add_parser("refresh", help="每日推算最新日并生成预警")
    args = parser.parse_args()
    if args.cmd == "train":
        cmd_train()
    elif args.cmd == "enable":
        cmd_enable(args.version, args.by)
    elif args.cmd == "calculate":
        cmd_calculate(args.date, args.alerts)
    elif args.cmd == "backfill":
        cmd_backfill(args.start, args.end)
    elif args.cmd == "refresh":
        cmd_refresh()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
