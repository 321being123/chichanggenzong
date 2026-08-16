# -*- coding: utf-8 -*-
"""可转债新债流通规模动态校准。"""
from datetime import date, datetime
from statistics import median

import db_pg
from _common import _load_env

_load_env()


LIQUIDITY_MODEL_VERSION = "dynamic_residual_v5"
MIN_WINDOW_SAMPLES = 1
MIN_ACTIVE_SAMPLES = 1
MAX_BUCKET_RADIUS = 1
ADJUSTMENT_MIN_PP = -25.0
ADJUSTMENT_MAX_PP = 35.0

LIQUIDITY_BUCKETS = (
    (0, 1, "超小盘(<1亿)"),
    (1, 2, "极小盘(1-2亿)"),
    (2, 3, "小盘(2-3亿)"),
    (3, 4, "中小盘(3-4亿)"),
    (4, 5, "中小盘(4-5亿)"),
    (5, 6, "中盘(5-6亿)"),
    (6, 8, "中盘B(6-8亿)"),
    (8, 10, "中大盘(8-10亿)"),
    (10, 15, "大盘(10-15亿)"),
    (15, 25, "超大盘(15-25亿)"),
    (25, float("inf"), "巨盘(≥25亿)"),
)


def liquidity_bucket(value):
    """返回 (档位序号, 标签)。"""
    scale = float(value)
    for index, (low, high, label) in enumerate(LIQUIDITY_BUCKETS):
        if low <= scale < high:
            return index, label
    return len(LIQUIDITY_BUCKETS) - 1, LIQUIDITY_BUCKETS[-1][2]


def robust_mean(values):
    """少于10个样本取中位数；否则去掉两端各10%后求平均。"""
    numbers = sorted(float(value) for value in values if value is not None)
    if not numbers:
        return None
    if len(numbers) < 10:
        return float(median(numbers))
    trim = max(1, int(len(numbers) * 0.10))
    kept = numbers[trim:-trim]
    return sum(kept) / len(kept)


def _select_comparable_samples(samples, target_scale):
    target_index, _ = liquidity_bucket(target_scale)
    exact = [row for row in samples if liquidity_bucket(row["circulation_scale"])[0] == target_index]
    if len(exact) >= MIN_WINDOW_SAMPLES:
        return exact, "同档"

    for radius in range(1, MAX_BUCKET_RADIUS + 1):
        adjacent = [
            row for row in samples
            if abs(liquidity_bucket(row["circulation_scale"])[0] - target_index) <= radius
        ]
        if len(adjacent) >= MIN_WINDOW_SAMPLES:
            return adjacent, "相邻档合并"

    return exact, "同档及相邻档样本不足"


def _preferred_comparable_samples(samples, target_scale):
    """真实日报样本优先；真实样本不足时才回退历史回滚样本。"""
    real_samples = [row for row in samples if not row.get("is_backfilled", False)]
    if real_samples:
        selected, method = _select_comparable_samples(real_samples, target_scale)
        if len(selected) >= MIN_WINDOW_SAMPLES:
            return selected, f"{method}（真实样本）"
    return _select_comparable_samples(samples, target_scale)


def _window_impact(samples, target_scale):
    if len(samples) < MIN_WINDOW_SAMPLES:
        return None
    selected, method = _preferred_comparable_samples(samples, target_scale)
    if len(selected) < MIN_WINDOW_SAMPLES:
        return None
    selected_mean = robust_mean(row["residual_pp"] for row in selected)
    market_mean = robust_mean(row["residual_pp"] for row in samples)
    return {
        "impact_pp": selected_mean,
        "sample_count": len(selected),
        "market_count": len(samples),
        "market_mean_pp": market_mean,
        "method": method,
        "sample_source": "historical_backfill" if all(
            row.get("is_backfilled", False) for row in selected
        ) else "live",
    }


def calculate_adjustment_from_samples(target_scale, recent_samples, older_samples):
    """按近3个月70% + 第4至6个月30%计算流通规模影响。"""
    all_half_year = list(recent_samples) + list(older_samples)
    if len(all_half_year) < MIN_ACTIVE_SAMPLES:
        _, label = liquidity_bucket(target_scale)
        return {
            "adjustment_pp": 0.0, "raw_adjustment_pp": 0.0,
            "bucket_label": label, "sample_count": len(all_half_year),
            "recent": None, "older": None, "half_year": None,
            "weight_text": f"近半年有效样本{len(all_half_year)}只，未达到{MIN_ACTIVE_SAMPLES}只启用门槛，暂不调整",
            "model_version": LIQUIDITY_MODEL_VERSION,
            "sample_source": "none",
        }
    recent = _window_impact(recent_samples, target_scale)
    # 第4至6个月本身样本很少时，半年稳定项使用完整近半年窗口。
    older = _window_impact(older_samples, target_scale)
    half_year = _window_impact(all_half_year, target_scale)
    if recent and older:
        raw = recent["impact_pp"] * 0.70 + older["impact_pp"] * 0.30
        weight_text = "近3个月70% + 第4至6个月30%"
    elif recent and half_year:
        raw = recent["impact_pp"] * 0.70 + half_year["impact_pp"] * 0.30
        weight_text = "近3个月70% + 近半年稳定项30%"
    elif half_year:
        raw = half_year["impact_pp"]
        weight_text = "近半年（近3个月有效样本不足）"
    else:
        raw = 0.0
        weight_text = f"同档或紧邻档有效样本不足{MIN_WINDOW_SAMPLES}只，暂不调整"

    adjustment = max(ADJUSTMENT_MIN_PP, min(ADJUSTMENT_MAX_PP, raw))
    _, label = liquidity_bucket(target_scale)
    return {
        "adjustment_pp": round(adjustment, 2),
        "raw_adjustment_pp": round(raw, 2),
        "bucket_label": label,
        "sample_count": len({
            (row["circulation_scale"], row["residual_pp"])
            for row in all_half_year
        }),
        "recent": recent,
        "older": older,
        "half_year": half_year,
        "weight_text": weight_text,
        "model_version": LIQUIDITY_MODEL_VERSION,
        "sample_source": "historical_backfill" if any(
            section and section.get("sample_source") == "historical_backfill"
            for section in (recent, older, half_year)
        ) else "live",
    }


def _as_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "")[:10]
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return date.today()


def calculate_liquidity_adjustment(circulation_scale, as_of_date=None):
    """从 PostgreSQL 历史预测与实际结果计算目标转债的动态流通调整。"""
    if circulation_scale is None:
        return None
    target_date = _as_date(as_of_date)
    conn = db_pg.connect()
    try:
        rows = conn.execute(
            """SELECT listing_date,circulation_scale,
                      (actual_price-base_price_no_liquidity)/NULLIF(transfer_value,0)*100 AS residual_pp,
                      valuation_context,valuation_model_version
                 FROM predictions
                WHERE type='bond' AND status='fulfilled'
                  AND actual_price IS NOT NULL AND base_price_no_liquidity IS NOT NULL
                  AND transfer_value BETWEEN 30 AND 300
                  AND circulation_scale > 0
                  AND listing_date::date < %s::date
                  AND listing_date::date >= %s::date - INTERVAL '6 months'
                  AND valuation_model_version IS NOT NULL""",
            (target_date.isoformat(), target_date.isoformat()),
        ).fetchall()
    finally:
        conn.close()

    recent, older = [], []
    for listing_date, scale, residual, context, model_version in rows:
        if scale is None or residual is None:
            continue
        row_date = _as_date(listing_date)
        age_days = (target_date - row_date).days
        context = context if isinstance(context, dict) else {}
        source = str(context.get("source") or "")
        is_backfilled = (
            source in ("historical_rollback", "legacy_snapshot")
            or str(model_version or "").startswith("historical_")
        )
        item = {
            "circulation_scale": float(scale),
            "residual_pp": float(residual),
            "is_backfilled": is_backfilled,
        }
        if age_days <= 92:
            recent.append(item)
        else:
            older.append(item)
    return calculate_adjustment_from_samples(float(circulation_scale), recent, older)


__all__ = [
    "LIQUIDITY_MODEL_VERSION", "LIQUIDITY_BUCKETS", "MIN_ACTIVE_SAMPLES", "liquidity_bucket", "robust_mean",
    "calculate_adjustment_from_samples", "calculate_liquidity_adjustment",
]
