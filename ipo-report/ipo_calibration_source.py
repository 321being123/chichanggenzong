# -*- coding: utf-8 -*-
"""调参脚本联网适配：东财新股详情页抓取（唯一外采落点）。"""
import requests

_session = requests.Session()
_session.headers.update({'User-Agent': 'Mozilla/5.0'})

DETAIL_URL = "https://ds.emoney.cn/DataCenter2/datacenter/NewStockXgzl?secucode={code}&type=ss"


def fetch_new_stock_detail(code, timeout=15):
    """抓取东财新股详情页 HTML 文本。"""
    resp = _session.get(DETAIL_URL.format(code=code), timeout=timeout)
    resp.raise_for_status()
    return resp.text
