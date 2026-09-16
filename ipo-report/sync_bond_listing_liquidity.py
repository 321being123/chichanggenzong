#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在现有可转债公告同步任务中，增量补齐上市流通规模。"""
import argparse
import json

from external_call_guard import install_requests_guard

install_requests_guard()

import db_pg
from bond_data_layer import get_listing_liquidity, save_listing_liquidity
from ipo_lib_fetch import fetch_placing_result


def listing_candidates(days=60, codes=None, limit=None):
    conn = db_pg.connect()
    try:
        params = [max(int(days), 1)]
        clauses = [
            "e.event_type='listing'",
            "e.event_date >= CURRENT_DATE - (%s * INTERVAL '1 day')",
            "i.asset_class='convertible_bond'",
            "(iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))",
        ]
        if codes:
            params.append([str(code).split('.')[0] for code in codes if str(code).strip()])
            clauses.append("split_part(i.canonical_code,'.',1)=ANY(%s)")
        else:
            # 旧版本写入的巨潮事实也需要迁移为交易所事实；新版本只跳过已用交易所来源核实的记录。
            clauses.append("(l.instrument_id IS NULL OR l.source_code IS NULL OR l.source_code LIKE 'cninfo%')")
        limit_value = max(int(limit or 0), 0)
        limit_clause = " LIMIT %s" if limit_value else ""
        if limit_value:
            params.append(limit_value)
        rows = conn.execute(
            f"""SELECT DISTINCT ON (i.instrument_id)
                          split_part(i.canonical_code,'.',1),i.name,e.event_date::date,
                          split_part(si.canonical_code,'.',1),si.name,
                          COALESCE(iss.issue_size_100m_yuan,p.issue_size/100000000.0)
                     FROM event.instrument_events e
                     JOIN core.instruments i ON i.instrument_id=e.instrument_id
                     JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
                     LEFT JOIN core.instruments si ON si.instrument_id=p.stock_instrument_id
                     LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
                     LEFT JOIN analytics.convertible_bond_listing_liquidity l ON l.instrument_id=i.instrument_id
                    WHERE {' AND '.join(clauses)}
                    ORDER BY i.instrument_id,e.event_date DESC
                    {limit_clause}""",
            params,
        ).fetchall()
        return rows
    finally:
        conn.close()


def sync_liquidity(days=60, codes=None, limit=None):
    rows = listing_candidates(days=days, codes=codes, limit=limit)
    forced_codes = {str(code).split('.')[0] for code in (codes or []) if str(code).strip()}
    result = {"ok": True, "candidates": len(rows), "saved": 0, "skipped": 0, "failed": 0, "failures": []}
    for code, bond_name, listing_date, stock_code, stock_name, issue_scale in rows:
        cached = get_listing_liquidity(code)
        if code not in forced_codes and cached and cached.get("source_code") in ("sse", "szse"):
            result["skipped"] += 1
            continue
        if not stock_code or not issue_scale:
            result["failed"] += 1
            result["failures"].append({"code": code, "error": "缺少正股代码或发行规模"})
            continue
        try:
            payload = fetch_placing_result(
                stock_code,
                float(issue_scale),
                bond_code=code,
                stock_name=stock_name,
                listing_date=listing_date,
            )
            if save_listing_liquidity(code, payload, listing_date):
                result["saved"] += 1
            else:
                result["failed"] += 1
                result["failures"].append({"code": code, "error": (payload or {}).get("error", "公告解析失败")})
        except Exception as error:
            result["failed"] += 1
            result["failures"].append({"code": code, "error": str(error)[:500]})
    if result["failed"]:
        result["ok"] = False
        result["status"] = "partial" if result["saved"] or result["skipped"] else "stale"
    else:
        result["status"] = "succeeded"
    # 显式上限只供人工调试；存在未处理候选时不得报告完整成功。
    if int(limit or 0) > 0:
        remaining = listing_candidates(days=days, codes=codes, limit=None)
        result["remaining_candidates"] = len(remaining)
        if remaining:
            result["ok"] = False
            result["status"] = "partial"
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--limit", type=int, default=0, help="人工调试上限；默认处理全部待补缺口")
    parser.add_argument("--codes", default="", help="逗号分隔的债券代码")
    args = parser.parse_args()
    codes = [item.strip() for item in args.codes.split(',') if item.strip()]
    print(json.dumps(sync_liquidity(days=args.days, codes=codes or None, limit=args.limit), ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
