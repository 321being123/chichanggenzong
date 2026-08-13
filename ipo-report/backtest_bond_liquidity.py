#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按时间顺序回测动态流通规模调整，禁止使用预测日之后的数据。"""
import json
from statistics import mean

import db_pg
from ipo_lib_liquidity import calculate_liquidity_adjustment


def main():
    conn = db_pg.connect()
    try:
        rows = conn.execute(
            """SELECT code,name,listing_date,actual_price,transfer_value,circulation_scale,
                      base_price_no_liquidity,pred_price
                 FROM predictions
                WHERE type='bond' AND actual_price IS NOT NULL AND transfer_value > 0
                  AND circulation_scale > 0 AND base_price_no_liquidity IS NOT NULL
                ORDER BY listing_date::date,code"""
        ).fetchall()
    finally:
        conn.close()

    old_errors = []
    new_errors = []
    details = []
    for code, name, listing_date, actual, tv, scale, base, old_price in rows:
        calibration = calculate_liquidity_adjustment(scale, listing_date)
        new_price = float(base) + float(tv) * calibration["adjustment_pp"] / 100
        old_error = abs(float(old_price) - float(actual))
        new_error = abs(new_price - float(actual))
        old_errors.append(old_error)
        new_errors.append(new_error)
        details.append({
            "code": code, "name": name, "date": str(listing_date),
            "samples": calibration["sample_count"],
            "adjustment_pp": calibration["adjustment_pp"],
            "old_error": round(old_error, 2), "new_error": round(new_error, 2),
        })
    result = {
        "samples": len(details),
        "old_mae_yuan": round(mean(old_errors), 2) if old_errors else None,
        "new_mae_yuan": round(mean(new_errors), 2) if new_errors else None,
        "details": details,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
