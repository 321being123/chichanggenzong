"""可转债中性公允价策略的只读历史回测。

数据：
- 本地 PostgreSQL：market.convertible_bond_daily_metrics
- Tushare cb_basic：上市日、到期日、退市日

原则：
- 年度滚动训练，只使用预测年度之前的数据；
- 去除每日市场整体溢价后学习单券结构差异；
- 公允价使用历史市场溢价中位数，不使用预测当天的市场热度；
- 当前横向排名只用于检验区分能力，不用于强制产生“低估券”。
"""

import json
import math
import os
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
import requests
import xgboost as xgb


ROOT = Path(__file__).resolve().parents[1]
HORIZONS = (20, 60, 120)
FEATURES = ("log_cv", "log_bv", "log_cv_bv", "remaining_years", "cv_vol60")


def load_env():
    for raw in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip("\"'")
        os.environ.setdefault(key.strip(), value)


def tushare_cb_basic():
    token = os.environ.get("TUSHARE_TOKEN", "").strip()
    if not token:
        raise RuntimeError("TUSHARE_TOKEN 未配置")
    fields = "ts_code,list_date,delist_date,maturity_date"
    response = requests.post(
        "https://api.tushare.pro",
        json={"api_name": "cb_basic", "token": token, "params": {}, "fields": fields},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(f"cb_basic 调用失败：{payload.get('code')} {payload.get('msg')}")
    data = payload.get("data") or {}
    columns = data.get("fields") or []
    rows = data.get("items") or []
    if len(rows) >= 2000:
        raise RuntimeError("cb_basic 达到2000行上限，存在截断风险")
    if any(len(row) != len(columns) for row in rows):
        raise RuntimeError("cb_basic 返回字段与数据长度不一致")
    return pd.DataFrame(rows, columns=columns)


def database_connection():
    if os.environ.get("DATABASE_URL"):
        return psycopg2.connect(os.environ["DATABASE_URL"])
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "localhost"),
        port=os.environ.get("PGPORT", "5432"),
        user=os.environ.get("PGUSER"),
        password=os.environ.get("PGPASSWORD"),
        dbname=os.environ.get("PGDATABASE"),
    )


def load_daily_facts():
    sql = """
      SELECT i.canonical_code AS ts_code,
             m.trade_date,
             m.close::float8 AS close,
             m.conversion_value::float8 AS conversion_value,
             m.conversion_premium_pct::float8 AS conversion_premium_pct,
             m.bond_value::float8 AS bond_value
        FROM market.convertible_bond_daily_metrics m
        JOIN core.instruments i ON i.instrument_id=m.instrument_id
       WHERE m.close > 0
         AND m.conversion_value > 0
         AND m.bond_value > 0
       ORDER BY i.canonical_code,m.trade_date
    """
    with database_connection() as conn:
        return pd.read_sql_query(sql, conn)


def prepare_data(facts, basics):
    df = facts.copy()
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    for col in ("list_date", "delist_date", "maturity_date"):
        basics[col] = pd.to_datetime(basics[col], errors="coerce")
    basics = basics.drop_duplicates("ts_code", keep="last")
    df = df.merge(basics, on="ts_code", how="left", validate="many_to_one")
    df = df.sort_values(["ts_code", "trade_date"]).reset_index(drop=True)

    df["anchor"] = df[["conversion_value", "bond_value"]].max(axis=1)
    df["log_extra_ratio"] = np.log(df["close"] / df["anchor"])
    df["log_cv"] = np.log(df["conversion_value"])
    df["log_bv"] = np.log(df["bond_value"])
    df["log_cv_bv"] = np.log(df["conversion_value"] / df["bond_value"])
    df["remaining_years"] = (df["maturity_date"] - df["trade_date"]).dt.days / 365.25

    df["cv_return"] = df.groupby("ts_code", sort=False)["conversion_value"].pct_change(fill_method=None)
    df["cv_vol60"] = (
        df.groupby("ts_code", sort=False)["cv_return"]
        .rolling(60, min_periods=40)
        .std()
        .reset_index(level=0, drop=True)
        * math.sqrt(252)
    )
    for horizon in HORIZONS:
        future = df.groupby("ts_code", sort=False)["close"].shift(-horizon)
        future_anchor = df.groupby("ts_code", sort=False)["anchor"].shift(-horizon)
        df[f"return_{horizon}"] = future / df["close"] - 1
        df[f"anchor_return_{horizon}"] = future_anchor / df["anchor"] - 1
        df[f"anchor_adjusted_return_{horizon}"] = (
            (1 + df[f"return_{horizon}"]) / (1 + df[f"anchor_return_{horizon}"]) - 1
        )

    df["double_low"] = df["close"] + df["conversion_premium_pct"]
    df["raw_premium"] = df["conversion_premium_pct"]
    valid = (
        df[list(FEATURES)].replace([np.inf, -np.inf], np.nan).notna().all(axis=1)
        & df["remaining_years"].between(0.05, 8)
        & df["cv_vol60"].between(0, 3)
        & df["log_extra_ratio"].between(-0.5, 1.5)
    )
    return df.loc[valid].copy()


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


def fit_predict_annual(df):
    month_ends = monthly_dates(df)
    predictions = []
    model_diagnostics = []
    for year in range(2021, int(df["trade_date"].dt.year.max()) + 1):
        year_start = pd.Timestamp(year=year, month=1, day=1)
        train = df[df["trade_date"] < year_start].copy()
        predict_dates = [d for d in month_ends if d.year == year]
        test = df[df["trade_date"].isin(predict_dates)].copy()
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

        train_matrix = xgb.DMatrix(sample[list(FEATURES)], label=sample["target"])
        model = xgb.train(
            {
                "objective": "reg:absoluteerror",
                "max_depth": 4,
                "eta": 0.05,
                "min_child_weight": 20,
                "subsample": 0.8,
                "colsample_bytree": 0.9,
                "lambda": 5,
                "nthread": 4,
                "seed": 20260727,
            },
            train_matrix,
            num_boost_round=220,
        )
        test["predicted_relative_extra"] = model.predict(xgb.DMatrix(test[list(FEATURES)]))
        test["neutral_market_log_extra"] = neutral_market
        test["fair_log_extra"] = neutral_market + test["predicted_relative_extra"]
        test["fair_price"] = test["anchor"] * np.exp(test["fair_log_extra"])
        test["absolute_deviation"] = test["close"] / test["fair_price"] - 1
        predictions.append(test)
        model_diagnostics.append(
            {
                "year": year,
                "train_start": train["trade_date"].min().date().isoformat(),
                "train_end": train["trade_date"].max().date().isoformat(),
                "train_rows_sampled": int(len(sample)),
                "neutral_market_extra_pct": round((math.exp(neutral_market) - 1) * 100, 3),
                "prediction_rows": int(len(test)),
            }
        )
    if not predictions:
        raise RuntimeError("没有产生样本外预测")
    result = pd.concat(predictions, ignore_index=True)
    result["market_heat"] = result.groupby("trade_date")["absolute_deviation"].transform("median")
    result["relative_to_market"] = result["absolute_deviation"] - result["market_heat"]
    return result, model_diagnostics


def portfolio_results(predictions, universe_name, universe_filter):
    rows = []
    subset = predictions.loc[universe_filter(predictions)].copy()
    signals = {
        "中性公允价偏离": "absolute_deviation",
        "双低值": "double_low",
        "转股溢价率": "raw_premium",
    }
    for signal_name, signal_col in signals.items():
        for horizon in HORIZONS:
            monthly = []
            for date, day in subset.groupby("trade_date"):
                day = day.dropna(subset=[signal_col, f"return_{horizon}"]).copy()
                if len(day) < 50:
                    continue
                day["rank"] = day[signal_col].rank(method="first", pct=True)
                low = day.loc[day["rank"] <= 0.2, f"return_{horizon}"]
                high = day.loc[day["rank"] > 0.8, f"return_{horizon}"]
                monthly.append(
                    {
                        "trade_date": date,
                        "low": low.mean(),
                        "high": high.mean(),
                        "spread": low.mean() - high.mean(),
                        "universe": day[f"return_{horizon}"].mean(),
                        "count": len(day),
                    }
                )
            monthly = pd.DataFrame(monthly)
            rows.append(
                {
                    "universe": universe_name,
                    "signal": signal_name,
                    "horizon": horizon,
                    "months": int(len(monthly)),
                    "avg_count": round(float(monthly["count"].mean()), 1),
                    "low_return_pct": round(float(monthly["low"].mean() * 100), 3),
                    "high_return_pct": round(float(monthly["high"].mean() * 100), 3),
                    "spread_pct": round(float(monthly["spread"].mean() * 100), 3),
                    "spread_win_rate_pct": round(float((monthly["spread"] > 0).mean() * 100), 1),
                    "market_return_pct": round(float(monthly["universe"].mean() * 100), 3),
                }
            )
    return rows


def market_heat_results(predictions):
    monthly = (
        predictions.groupby("trade_date")
        .agg(
            market_heat=("absolute_deviation", "median"),
            over_zero=("absolute_deviation", lambda s: (s > 0).mean()),
            over_ten=("absolute_deviation", lambda s: (s > 0.10).mean()),
            count=("ts_code", "size"),
            **{f"market_return_{h}": (f"return_{h}", "mean") for h in HORIZONS},
        )
        .reset_index()
    )
    cutoff = monthly["market_heat"].quantile(0.8)
    monthly["hot"] = monthly["market_heat"] >= cutoff
    results = []
    for horizon in HORIZONS:
        col = f"market_return_{horizon}"
        ranked_heat = monthly["market_heat"].rank()
        ranked_return = monthly[col].rank()
        correlation = ranked_heat.corr(ranked_return)
        results.append(
            {
                "horizon": horizon,
                "heat_return_rank_corr": round(float(correlation), 3),
                "hot_month_return_pct": round(float(monthly.loc[monthly["hot"], col].mean() * 100), 3),
                "other_month_return_pct": round(float(monthly.loc[~monthly["hot"], col].mean() * 100), 3),
            }
        )
    hot = monthly[monthly["hot"]]
    latest = monthly.iloc[-1]
    return {
        "month_count": int(len(monthly)),
        "hot_cutoff_pct": round(float(cutoff * 100), 3),
        "hot_month_average_heat_pct": round(float(hot["market_heat"].mean() * 100), 3),
        "hot_month_average_over_zero_pct": round(float(hot["over_zero"].mean() * 100), 1),
        "hot_month_average_over_ten_pct": round(float(hot["over_ten"].mean() * 100), 1),
        "forward_returns": results,
        "latest": {
            "trade_date": latest["trade_date"].date().isoformat(),
            "bond_count": int(latest["count"]),
            "market_heat_pct": round(float(latest["market_heat"] * 100), 3),
            "over_zero_pct": round(float(latest["over_zero"] * 100), 1),
            "over_ten_pct": round(float(latest["over_ten"] * 100), 1),
            "is_top_20pct_hot": bool(latest["hot"]),
        },
    }


def yearly_model_results(predictions, universe_name, universe_filter):
    subset = predictions.loc[universe_filter(predictions)].copy()
    output = []
    for horizon in HORIZONS:
        monthly = []
        for date, day in subset.groupby("trade_date"):
            day = day.dropna(subset=["absolute_deviation", f"return_{horizon}"]).copy()
            if len(day) < 50:
                continue
            day["rank"] = day["absolute_deviation"].rank(method="first", pct=True)
            low = day.loc[day["rank"] <= 0.2, f"return_{horizon}"].mean()
            high = day.loc[day["rank"] > 0.8, f"return_{horizon}"].mean()
            monthly.append({"trade_date": date, "spread": low - high})
        monthly = pd.DataFrame(monthly)
        if monthly.empty:
            continue
        monthly["year"] = monthly["trade_date"].dt.year
        for year, group in monthly.groupby("year"):
            output.append(
                {
                    "universe": universe_name,
                    "horizon": horizon,
                    "year": int(year),
                    "months": int(len(group)),
                    "spread_pct": round(float(group["spread"].mean() * 100), 3),
                    "win_rate_pct": round(float((group["spread"] > 0).mean() * 100), 1),
                }
            )
    return output


def valuation_convergence_results(predictions, universe_name, universe_filter):
    subset = predictions.loc[universe_filter(predictions)].copy()
    aggregate = []
    yearly = []
    for horizon in HORIZONS:
        monthly = []
        return_col = f"anchor_adjusted_return_{horizon}"
        for date, day in subset.groupby("trade_date"):
            day = day.dropna(subset=["absolute_deviation", return_col]).copy()
            if len(day) < 50:
                continue
            day["rank"] = day["absolute_deviation"].rank(method="first", pct=True)
            low = day.loc[day["rank"] <= 0.2, return_col].mean()
            high = day.loc[day["rank"] > 0.8, return_col].mean()
            monthly.append({"trade_date": date, "spread": low - high, "low": low, "high": high})
        monthly = pd.DataFrame(monthly)
        if monthly.empty:
            continue
        aggregate.append(
            {
                "universe": universe_name,
                "horizon": horizon,
                "months": int(len(monthly)),
                "low_anchor_adjusted_return_pct": round(float(monthly["low"].mean() * 100), 3),
                "high_anchor_adjusted_return_pct": round(float(monthly["high"].mean() * 100), 3),
                "spread_pct": round(float(monthly["spread"].mean() * 100), 3),
                "spread_win_rate_pct": round(float((monthly["spread"] > 0).mean() * 100), 1),
            }
        )
        monthly["year"] = monthly["trade_date"].dt.year
        for year, group in monthly.groupby("year"):
            yearly.append(
                {
                    "universe": universe_name,
                    "horizon": horizon,
                    "year": int(year),
                    "months": int(len(group)),
                    "spread_pct": round(float(group["spread"].mean() * 100), 3),
                    "win_rate_pct": round(float((group["spread"] > 0).mean() * 100), 1),
                }
            )
    return aggregate, yearly


def main():
    load_env()
    basics = tushare_cb_basic()
    facts = load_daily_facts()
    prepared = prepare_data(facts, basics)
    predictions, diagnostics = fit_predict_annual(prepared)

    portfolio = []
    portfolio += portfolio_results(predictions, "全部有效样本", lambda x: pd.Series(True, index=x.index))
    portfolio += portfolio_results(predictions, "纯债价值不低于85的稳健代理样本", lambda x: x["bond_value"] >= 85)
    convergence_all, convergence_yearly_all = valuation_convergence_results(
        predictions, "全部有效样本", lambda x: pd.Series(True, index=x.index)
    )
    convergence_stable, convergence_yearly_stable = valuation_convergence_results(
        predictions, "纯债价值不低于85的稳健代理样本", lambda x: x["bond_value"] >= 85
    )

    output = {
        "data": {
            "source": "Tushare cb_daily + cb_basic",
            "fact_rows": int(len(facts)),
            "prepared_rows": int(len(prepared)),
            "prediction_rows": int(len(predictions)),
            "bond_count": int(prepared["ts_code"].nunique()),
            "date_start": prepared["trade_date"].min().date().isoformat(),
            "date_end": prepared["trade_date"].max().date().isoformat(),
            "cb_basic_rows": int(len(basics)),
        },
        "method": {
            "features": list(FEATURES),
            "training": "按年滚动，预测年度之前的数据；训练日每5个交易日抽样",
            "price_return": "不含票息；按单券后续第20/60/120个有效行情记录计算",
            "safety_limit": "缺少完整的历史时点安全性快照，纯债价值>=85仅作敏感性检验，不代替现有安全性模块",
        },
        "model_diagnostics": diagnostics,
        "portfolio_results": portfolio,
        "yearly_model_results": (
            yearly_model_results(predictions, "全部有效样本", lambda x: pd.Series(True, index=x.index))
            + yearly_model_results(predictions, "纯债价值不低于85的稳健代理样本", lambda x: x["bond_value"] >= 85)
        ),
        "valuation_convergence_results": convergence_all + convergence_stable,
        "yearly_valuation_convergence": convergence_yearly_all + convergence_yearly_stable,
        "market_heat": market_heat_results(predictions),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
