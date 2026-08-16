# -*- coding: utf-8 -*-
"""可转债历史预测回滚的纯计算逻辑。

只接收已经从数据库读出的历史事实，不在这里联网，也不直接写库。
"""
from datetime import date, datetime
from math import isfinite
from statistics import median

from ipo_lib_liquidity import calculate_adjustment_from_samples
from ipo_lib_sector import detect_hot_sector


HISTORICAL_ROLLBACK_MODEL_VERSION = "historical_rollback_v1"
HISTORICAL_WINDOW_DAYS = 184


def _as_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "")[:10]
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


def _market_premiums(market_rows):
    values = []
    for row in market_rows or []:
        if isinstance(row, dict):
            transfer_value = row.get("conversion_value")
            premium = row.get("conversion_premium_pct")
        else:
            transfer_value, premium = row[0], row[1]
        transfer_value = _number(transfer_value)
        premium = _number(premium)
        if transfer_value is not None and transfer_value > 0 and premium is not None:
            values.append((transfer_value, premium))
    return values


def estimate_historical_base_premium(transfer_value, market_rows):
    """按现有日报的转股价值分档规则，使用预测日前市场截面估算基础溢价。"""
    target = _number(transfer_value)
    if target is None or target <= 0:
        return None, 0
    values = _market_premiums(market_rows)
    if not values:
        return None, 0

    bucket = int(target // 10) * 10
    bucket_values = sorted(premium for value, premium in values if bucket <= value < bucket + 10)
    if len(bucket_values) >= 3:
        return median(bucket_values) / 100, len(bucket_values)

    nearby = sorted(premium for value, premium in values if abs(value - target) <= 15)
    if len(nearby) >= 3:
        return median(nearby) / 100, len(nearby)

    nearby = sorted(premium for value, premium in values if abs(value - target) <= 25)
    if len(nearby) >= 3:
        return median(nearby) / 100, len(nearby)

    all_values = sorted(premium for _, premium in values)
    return median(all_values) / 100, len(all_values)


def rating_adjustment(rating):
    """保持日报现有评级调整口径。"""
    value = str(rating or "").strip().upper()
    if value.startswith("AAA"):
        return 0.05
    if value.startswith("AA+"):
        return 0.03
    if value.startswith("AA"):
        return 0.0
    if value:
        return -0.05
    return 0.0


def issue_size_adjustment(issue_scale):
    """保持日报现有发行规模折扣口径。"""
    value = _number(issue_scale) or 0
    if value >= 300:
        return -0.18
    if value >= 100:
        return -0.10
    if value >= 50:
        return -0.05
    return 0.0


def historical_base_price(transfer_value, market_rows, rating="", issue_scale=None,
                          bond_name="", stock_name=""):
    """计算不含流通规模调整的历史基础价，并返回可审计拆分。"""
    base_premium, market_sample_count = estimate_historical_base_premium(transfer_value, market_rows)
    target = _number(transfer_value)
    if target is None or base_premium is None:
        return None
    sector_label, sector_boost = detect_hot_sector(bond_name, stock_name, "")
    rating_adj = rating_adjustment(rating)
    issue_adj = issue_size_adjustment(issue_scale)
    total_base_premium = base_premium + rating_adj + sector_boost + issue_adj
    return {
        "base_price_no_liquidity": round(target * (1 + total_base_premium), 2),
        "base_premium": round(base_premium, 8),
        "rating_adjustment": round(rating_adj, 8),
        "sector_label": sector_label or "",
        "sector_adjustment": round(sector_boost, 8),
        "issue_size_adjustment": round(issue_adj, 8),
        "market_sample_count": market_sample_count,
        "model_version": HISTORICAL_ROLLBACK_MODEL_VERSION,
    }


def prior_liquidity_samples(samples, target_date, window_days=HISTORICAL_WINDOW_DAYS):
    """只保留预测日前的样本，分成近3个月和第4至6个月。"""
    target = _as_date(target_date)
    recent, older = [], []
    if target is None:
        return recent, older
    for sample in samples or []:
        listing_date = _as_date(sample.get("listing_date"))
        if listing_date is None or listing_date >= target:
            continue
        age_days = (target - listing_date).days
        if age_days <= 0 or age_days > window_days:
            continue
        item = {
            "circulation_scale": _number(sample.get("circulation_scale")),
            "residual_pp": _number(sample.get("residual_pp")),
            "is_backfilled": bool(sample.get("is_backfilled", True)),
        }
        if item["circulation_scale"] is None or item["circulation_scale"] <= 0 or item["residual_pp"] is None:
            continue
        (recent if age_days <= 92 else older).append(item)
    return recent, older


def rollback_prediction(transfer_value, circulation_scale, market_rows, listing_date,
                        prior_samples, rating="", issue_scale=None, bond_name="", stock_name=""):
    """按时间顺序回滚单只转债的历史预测。"""
    base = historical_base_price(
        transfer_value, market_rows, rating=rating, issue_scale=issue_scale,
        bond_name=bond_name, stock_name=stock_name,
    )
    if not base:
        return None
    recent, older = prior_liquidity_samples(prior_samples, listing_date)
    calibration = calculate_adjustment_from_samples(circulation_scale, recent, older)
    target = _number(transfer_value)
    adjustment_pp = float(calibration.get("adjustment_pp") or 0)
    tracking_price = round(
        target * (1 + base["base_premium"] + base["rating_adjustment"]
                  + base["sector_adjustment"] + base["issue_size_adjustment"]
                  + adjustment_pp / 100),
        2,
    )
    return {
        **base,
        "tracking_price": tracking_price,
        "liquidity_adjustment_pp": round(adjustment_pp, 2),
        "liquidity_sample_count": int(calibration.get("sample_count") or 0),
        "liquidity_calibration": calibration,
    }


__all__ = [
    "HISTORICAL_ROLLBACK_MODEL_VERSION", "HISTORICAL_WINDOW_DAYS",
    "estimate_historical_base_premium", "rating_adjustment", "issue_size_adjustment",
    "historical_base_price", "prior_liquidity_samples", "rollback_prediction",
]
