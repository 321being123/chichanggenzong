#!/usr/bin/env python3
"""一次性回填 ipo_history 的 industry 与 industry_pe。

背景：
- 历史表 ipo_history 的 industry 字段大量为空（早期写入未带行业）。
- industry_pe 为空是因为没有行业可查映射。
本脚本：
1. 构建 行业->中位数PE 映射（_get_industry_pe_map）
2. 一次拉全 stock_basic 的 ts_code->industry，给每行补 industry
3. 用映射给每行补 industry_pe
可重复运行（幂等）。
"""
import ipo_daily_report as m
import db_pg


def main():
    mp = m._get_industry_pe_map()
    if not mp:
        print("行业PE映射为空，跳过")
        return
    pro = m._get_tushare_pro()
    if not pro:
        print("Tushare 不可用，跳过"); return
    sb = pro.stock_basic(exchange='', list_status='L', fields='ts_code,industry')
    ind_by_code = {}
    if sb is not None and not sb.empty:
        ind_by_code = dict(zip(sb['ts_code'], sb['industry']))

    conn = db_pg.connect()
    cur = conn.cursor()
    cur.execute("SELECT security_code FROM ipo_history")
    codes = [r[0] for r in cur.fetchall()]
    upd_ind = 0
    upd_pe = 0
    for code in codes:
        ts = m._to_ts_code(code)
        ind = ind_by_code.get(ts) or ''
        if not ind:
            continue
        cur.execute("UPDATE ipo_history SET industry=%s WHERE security_code=%s", (ind, code))
        upd_ind += 1
        pe = mp.get(ind)
        if pe:
            cur.execute("UPDATE ipo_history SET industry_pe=%s WHERE security_code=%s", (pe, code))
            upd_pe += 1
    conn.commit()
    conn.close()
    print(f"行业映射 {len(mp)} 个; 更新行业 {upd_ind} 行, 更新行业PE {upd_pe} 行 (共 {len(codes)} 行)")


if __name__ == "__main__":
    main()
