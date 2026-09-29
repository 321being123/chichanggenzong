# 板块分类统一收口：避免 expand_data.py 与 ipo_daily_report.py 各写一份导致分叉。
# 纯函数，无外部依赖。


def _is_bj_stock(code):
    """判断是否是北交所股票（北交所暂不参与每日推荐）"""
    return str(code).startswith(("920", "82", "83", "87", "43"))


def board_key_from_code(code):
    """按证券代码前缀判定板块键；无法识别时返回“未知”，不猜测板块。

    预测、板块基准、申购单位和模型适用范围统一使用本函数，避免各处自建一套
    前缀判断后互相分叉。已知板块字段优先用 _market_type_to_board_key。
    """
    code_str = str(code or "").strip()
    if not code_str:
        return "未知"
    if code_str.startswith(("688", "787")):
        return "科创板"
    if code_str.startswith(("920", "82", "83", "87", "43")):
        return "北交所"
    if code_str.startswith(("300", "301")):
        return "创业板"
    if code_str.startswith(("000", "001", "002", "003")):
        return "深市主板"
    if code_str.startswith(("600", "601", "603", "605")):
        return "沪市主板"
    return "未知"


def _market_type_to_board_key(mt, code):
    """将 MARKET_TYPE（板块中文名或东财字段）+ 股票代码 映射到板块键。

    科创板/北交所直接返回；其余按代码前缀细分（300/301→创业板，
    000/001/002/003→深市主板，其它→沪市主板）。与历史两份实现行为一致。
    """
    s = str(mt or "")
    if s == "科创板":
        return "科创板"
    if s == "北交所":
        return "北交所"
    code_str = str(code)
    if code_str.startswith(("300", "301")):
        return "创业板"
    if code_str.startswith(("000", "001", "002", "003")):
        return "深市主板"
    return "沪市主板"
