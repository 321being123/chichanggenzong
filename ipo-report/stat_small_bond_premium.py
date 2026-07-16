#!/usr/bin/env python3
"""
用akshare + 东财datacenter获取可转债剩余规模，统计小流通妖债溢价率
bond_zh_cov 提供全量转债基础数据（价格、溢价率、发行规模等）
东财 datacenter RPT_BOND_CB_LIST 也有数据
关键：用腾讯行情里的 f84 字段（剩余张数）— 腾讯行情可达！
"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import akshare as ak
import pandas as pd
import numpy as np
import requests
import re

s = requests.Session()
s.headers.update({'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/'})

# 1. 获取全量转债数据
print("1. 获取全量转债数据 (bond_zh_cov)...")
df_all = ak.bond_zh_cov()
df_all['债现价'] = pd.to_numeric(df_all['债现价'], errors='coerce')
df_all['转股价值'] = pd.to_numeric(df_all['转股价值'], errors='coerce')
df_all['转股溢价率'] = pd.to_numeric(df_all['转股溢价率'], errors='coerce')
df_all['发行规模'] = pd.to_numeric(df_all['发行规模'], errors='coerce')

df_listed = df_all[df_all['债现价'] > 0].copy()
df_listed = df_listed[df_listed['转股溢价率'].notna()]
df_listed['债券代码'] = df_listed['债券代码'].astype(str)
print(f"   获取到 {len(df_listed)} 只有行情的转债")

# 2. 用腾讯行情获取剩余张数(f84)
# 腾讯行情返回格式中，字段[36]是成交量(手)，不是剩余张数
# 但字段[84]在stock/get里有，腾讯行情quotation里没有
# 换思路：用东财 datacenter 转股数据接口

# 尝试 akshare 的 bond_cb_jsl 获取剩余规模（只有30条，但可以多次翻页）
print("\n2. 获取集思录转债数据 (bond_cb_jsl)...")
df_jsl = ak.bond_cb_jsl()
df_jsl['代码'] = df_jsl['代码'].astype(str)
print(f"   获取到 {len(df_jsl)} 只转债（含剩余规模）")

# 3. merge
df_jsl_sub = df_jsl[['代码', '剩余规模']].copy()
df_jsl_sub.columns = ['债券代码', '剩余规模_jsl']
df_merged = df_listed.merge(df_jsl_sub, on='债券代码', how='left')

has_jsl = df_merged['剩余规模_jsl'].notna().sum()
print(f"   merge后有集思录剩余规模: {has_jsl}/{len(df_merged)} 只")

# 4. 对于没有集思录数据的转债，用东财datacenter获取转股信息
# 东财 datacenter RPT_BOND_CB_LIST 有 ACTUAL_ISSUE_SCALE 但没有剩余规模
# 用 datacenter 的可转债转股进度接口
print("\n3. 尝试东财 datacenter 获取转股进度...")

# 用 datacenter 批量获取转债转股数据
remain_map = {}
for page in range(1, 15):
    try:
        resp = s.get("https://datacenter-web.eastmoney.com/api/data/v1/get", params={
            "reportName": "RPT_BOND_CB_LIST",
            "columns": "SECURITY_CODE,ACTUAL_ISSUE_SCALE,LISTING_DATE,EXPIRE_DATE,DELIST_DATE",
            "pageNumber": page, "pageSize": 100,
            "sortTypes": -1, "sortColumns": "SECURITY_CODE",
            "source": "WEB", "client": "WEB",
        }, timeout=15)
        data = resp.json()
        if not (data.get("success") and data["result"] and data["result"]["data"]):
            break
        for b in data["result"]["data"]:
            sc = b.get("SECURITY_CODE", "")
            scale = b.get("ACTUAL_ISSUE_SCALE")
            if sc and scale:
                remain_map[sc] = float(scale)  # 暂用发行规模
    except:
        break

# 5. 对于缺失的转债，用发行规模作为剩余规模的近似
df_merged['剩余规模'] = df_merged['剩余规模_jsl']
# 缺失的用发行规模填充（注意：这是上限，实际剩余规模 <= 发行规模）
mask = df_merged['剩余规模'].isna()
df_merged.loc[mask, '剩余规模'] = df_merged.loc[mask, '发行规模']

has_remain = df_merged['剩余规模'].notna().sum()
print(f"\n4. 最终有剩余规模数据: {has_remain}/{len(df_merged)} 只")
print(f"   其中集思录精确数据: {has_jsl} 只, 发行规模近似: {has_remain - has_jsl} 只")

# 6. 统计
print("\n" + "="*60)
print("妖债溢价率统计结果（按剩余规模分组）")
print("="*60)
print(f"注：集思录数据为精确剩余规模，其余用发行规模近似（偏大）")
print(f"    实际剩余规模 <= 发行规模（因部分转股/回售/赎回）")

def print_stats(label, group):
    if len(group) == 0:
        print(f"\n  {label}（0 只）: 无数据")
        return
    avg = group['转股溢价率'].mean()
    med = group['转股溢价率'].median()
    print(f"\n  {label}（{len(group)} 只）:")
    print(f"    平均溢价率: {avg:.2f}%")
    print(f"    中位数溢价率: {med:.2f}%")
    print(f"    最小: {group['转股溢价率'].min():.2f}%  最大: {group['转股溢价率'].max():.2f}%")

df_real = df_merged[df_merged['剩余规模'].notna() & (df_merged['剩余规模'] > 0)].copy()

print_stats("剩余规模 < 0.5亿", df_real[df_real['剩余规模'] < 0.5])
print_stats("剩余规模 < 1亿", df_real[df_real['剩余规模'] < 1.0])
print_stats("剩余规模 < 2亿", df_real[df_real['剩余规模'] < 2.0])
print_stats("剩余规模 < 3亿", df_real[df_real['剩余规模'] < 3.0])
print_stats("剩余规模 < 5亿", df_real[df_real['剩余规模'] < 5.0])
print_stats("全市场转债", df_real)

# 7. 单独统计集思录精确数据的部分
print("\n" + "="*60)
print("集思录精确剩余规模数据统计（30只）")
print("="*60)
df_exact = df_merged[df_merged['剩余规模_jsl'].notna()].copy()
print_stats("剩余规模 < 1亿", df_exact[df_exact['剩余规模_jsl'] < 1.0])
print_stats("剩余规模 < 2亿", df_exact[df_exact['剩余规模_jsl'] < 2.0])
print_stats("剩余规模 < 3亿", df_exact[df_exact['剩余规模_jsl'] < 3.0])
print_stats("剩余规模 < 5亿", df_exact[df_exact['剩余规模_jsl'] < 5.0])
print_stats("全部精确数据", df_exact)

# 8. 明细
def print_details(label, df_sub, col='剩余规模'):
    if len(df_sub) == 0:
        return
    print(f"\n  {label} 明细（按溢价率降序）:")
    df_sorted = df_sub.sort_values('转股溢价率', ascending=False)
    for _, row in df_sorted.iterrows():
        jsl_mark = "" if pd.isna(row.get('剩余规模_jsl')) else " [精确]"
        print(f"    {row['债券代码']} {str(row['债券简称']):8s}  剩余={row[col]:.2f}亿  发行={row['发行规模']:.2f}亿  转股价值={row['转股价值']:7.2f}  溢价率={row['转股溢价率']:7.2f}%  价格={row['债现价']:.2f}{jsl_mark}")

print_details("剩余规模 < 1亿", df_real[df_real['剩余规模'] < 1.0])
print_details("剩余规模 1~2亿", df_real[(df_real['剩余规模'] >= 1.0) & (df_real['剩余规模'] < 2.0)])
print_details("剩余规模 2~3亿", df_real[(df_real['剩余规模'] >= 2.0) & (df_real['剩余规模'] < 3.0)])
