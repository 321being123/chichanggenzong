#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
套利公告正文提取与结构化解析
输入：公告 PDF 的 URL 或本地文件路径
输出：JSON（提取的证券代码、价格、比例、日期等关键字段 + confidence + 原文定位）
"""
import sys
import json
import re
import os

def load_env():
    """加载 .env 环境变量（与项目其他 Python 脚本一致）"""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    env_path = os.path.join(root, '.env')
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()

def extract_text_from_pdf(file_path):
    """用 PyMuPDF 提取 PDF 全文"""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return None, 'PyMuPDF not installed'
    try:
        doc = fitz.open(file_path)
        pages = []
        for page in doc:
            pages.append(page.get_text())
        doc.close()
        return '\n'.join(pages), None
    except Exception as e:
        return None, str(e)

def download_pdf(url, dest):
    """下载 PDF 到本地临时文件"""
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            if len(data) > 20 * 1024 * 1024:  # 20MB 上限
                return False, 'PDF exceeds size limit'
            with open(dest, 'wb') as f:
                f.write(data)
        return True, None
    except Exception as e:
        return False, str(e)

# ========== 正则提取模式 ==========

# 证券代码（A股6位 / 港股3-5位）—— 繁简兼容，接受全角冒号
RE_A_STOCK = re.compile(r'(?:證券代碼|证券代码|股票代碼|股票代码|代碼|代码)[:：\s]*(\d{6})')
# 港股代码只匹配港股常用词，避免从 A 股「股票代码：600095」里截出 5 位「60009」
RE_HK_STOCK = re.compile(r'(?:股份代號|股份代号|Stock\s*Code)[:：\s]*(\d{3,5})', re.I)

# 现金对价 / 注销价 / 要约价 / 收购价 / 换股价格 —— A股常见写法：「收购价格为每股X元」「要约收购价格为X元/股」
# 「异议股东收购请求权价格」「现金选择权价格」「A股换股价格」；港股写法：「註銷價為每股X港元」
RE_CASH_OFFER = re.compile(
    r'(?:現金對價|现金对价|'
    r'現金選擇權價格|现金选择权价格|異議股東收購請求權價格|异议股东收购请求权价格|'
    r'註銷價|注销价|注銷價|'
    r'要約收購(?:的)?價格|要约收购(?:的)?价格|'
    r'要約(?:的)?價格|要约(?:的)?价格|要約(?:的)?價|要约(?:的)?价|'
    r'收購(?:的)?價格|收购(?:的)?价格|收購(?:的)?價|收购(?:的)?价|收購(?:的)?價款|收购(?:的)?价款|'
    r'換股價格|换股价格|'
    r'現金代價|现金代价)'
            r'[\s:：]*'                              # 冒号/空格
    r'(?:為|为|是)?'                         # 为/是（简繁兼容）
    r'的?'                                   # 的（如「价格为的」/「价格为」）
    r'[\s:：]*'                              # 更多空格/冒号
    r'(?:每?股)?'                            # 可选「每股」
    r'(?:港幣|港元|港币|HK\$?|HKD|人民幣|人民币|RMB)?'  # 货币
    r'\s*'
    r'([\d.]+)', re.I)
# 供股价格 / 认购价 —— 「認購價為每股供股股份港幣6.25元」
RE_SUBSCRIPTION_PRICE = re.compile(
    r'(?:認購價|认购价|供股價|供股价|認購價格|认购价格|供股價格|供股价格)'
    r'[:：\s]*(?:為|为|是)?[:：\s]*(?:每?股[^\d]{0,15}?)?'
    r'(?:港幣|港元|港币|HK\$|HKD)?\s*([\d.]+)', re.I)

# 换股比例（换股吸收合并）：「換股比率為每X股換Y股」「每X股獲發Y股合併股份」「换股比例确定为X:Y」
# 注意：数字用「捕获组 (...)」而非非捕获组 (?:...)，否则 m.group(1) 为 None 导致崩溃
RE_SWAP_RATIO = re.compile(
    r'(?:換股比率|换股比率|換股比例|换股比例|合併比例|合并比例)[:：\s]*(?:為|为|是)?[:：\s]*'
    r'每?.{0,8}?(\(?\d+\.?\d*\)?)\s*股.{0,12}?(\(?\d+\.?\d*\)?)\s*股', re.I)
# 兜底1：无「换股比例」前缀时，匹配「每X股换Y股」写法
RE_SWAP_RATIO2 = re.compile(
    r'每\s*(\(?\d+\.?\d*\)?)\s*股.{0,30}?(?:換|换).{0,20}?(\(?\d+\.?\d*\)?)\s*股', re.I)
# 兜底2：A 股报告书常见「换股比例确定为1:1.27」「换股比例 1:1.27」
RE_SWAP_RATIO3 = re.compile(
    r'(?:換股比例|换股比例|換股比率|换股比率)[:：\s]*(?:為|为|是|指)?[:：\s]*[^。:：]{0,80}?(\d+\.?\d*)[:：](\d+\.?\d*)', re.I)

# 现金补偿
RE_CASH_COMP = re.compile(r'(?:現金補償|现金补偿|每股現金|每股现金|Cash\s*Component)[:：\s]*(?:為|为|是)?[:：\s]*([\d.]+)', re.I)

# 供股比例：「按每持有X股獲發Y股」「每持有X股可認購Y股」（数字常被括号包住，如 一(1)股）
# 数字用捕获组 (...)
RE_RIGHTS_RATIO = re.compile(
    r'每持有.{0,12}?(\(?\d+\)?)\s*股.{0,25}?(?:獲發|認購|配發|發行|獲配).{0,12}?(\(?\d+\)?)\s*股', re.I)

# 日期
RE_DATE = re.compile(r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日')
RE_DATE_ISO = re.compile(r'(\d{4}-\d{2}-\d{2})')

# 要约人
RE_OFFEROR = re.compile(r'(?:要約人|要约人|收購人|收购人|收購方|收购方)[:：\s]*(?:為|为|是)?[:：\s]*([^，。\n]{2,40})')

# 持股比例
RE_HOLDING_PCT = re.compile(r'(?:持股比例|持股量|持股百分比|Holding)[:：\s]*(?:為|为|是)?[:：\s]*([\d.]+)\s*%')

def _to_num(s):
    """从可能带括号/单位的文本中解析数值，失败返回 None。
    例如 '(1)' → 1.0、'6.25' → 6.25、'港幣6.25元' 经前置清洗后只留数字。"""
    if s is None:
        return None
    s = re.sub(r'[^\d.]', '', str(s))
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None

def _infer_short_name_by_code(text, code):
    """根据证券代码在文本中反查公司简称（支持代码在前/简称在前两种排版，分隔符可缺省）。"""
    pat = re.compile(
        r'(?:股票代码|证券代码|代碼|代码)[:：\s]*' + re.escape(code) + r'(?:\.\w+)?.{0,80}?(?:股票简称|证券简称|股票簡稱)[:：\s]*([^ 　\n]{2,20})',
        re.I | re.S)
    m = pat.search(text)
    if m:
        return m.group(1).strip()
    pat2 = re.compile(
        r'(?:股票简称|证券简称|股票簡稱)[:：\s]*([^ 　\n]{2,20}).{0,80}?(?:股票代码|证券代码|代碼|代码)[:：\s]*' + re.escape(code),
        re.I | re.S)
    m2 = pat2.search(text)
    if m2:
        return m2.group(1).strip()
    return None

def parse_fields(text, target_code=None):
    """从全文中提取结构化字段。

    target_code: 若已知目标证券代码（如 A 股换股吸收合并中的被吸收合并方），
                 会优先提取该代码附近的「换股价格」，并把该代码排在 target_codes 首位。
    """
    result = {
        'target_codes': [],
        'reference_codes': [],
        'rights_codes': [],
        'cash_offer_price': None,
        'subscription_price': None,
        'swap_ratio': None,
        'cash_component': None,
        'rights_ratio_numerator': None,
        'rights_ratio_denominator': None,
        'offeror': None,
        'offeror_holding_pct': None,
        'dates': {},
        'confidence': 0.0,
        'evidence': [],
    }

    if not text:
        return result

    # 收集全部证券代码（保留出现顺序，去重），并记下位置用于上下文归类
    code_hits = []  # (pos, code)
    for m in RE_A_STOCK.finditer(text):
        code_hits.append((m.start(), m.group(1)))
    for m in RE_HK_STOCK.finditer(text):
        code_hits.append((m.start(), m.group(1)))
    code_hits.sort()

    ordered_codes = []
    for _, code in code_hits:
        if code not in ordered_codes:
            ordered_codes.append(code)

    # 若调用方已告知目标证券代码，将其置顶，避免从财务顾问报告/合并方段落里取错价格
    if target_code and target_code in ordered_codes:
        ordered_codes.remove(target_code)
        ordered_codes.insert(0, target_code)

    # 主证券（发行人）：首个出现的代码
    if ordered_codes:
        result['target_codes'].append(ordered_codes[0])
        first_pos = next((pos for pos, code in code_hits if code == ordered_codes[0]), code_hits[0][0])
        result['evidence'].append({'field': 'target_code', 'value': ordered_codes[0], 'pos': first_pos})

    # 按上下文归类：参考证券（换股吸收合并的换股标的/合并方/收购方）、供股权证券（供股临时交易代码）
    # 排除主证券本身；同一代码只归一类，优先参考证券。
    primary = ordered_codes[0] if ordered_codes else None
    for pos, code in code_hits:
        if code == primary:
            continue
        ctx = text[max(0, pos - 30): pos + 30]
        is_rights_ctx = bool(re.search(r'供股|供股权|供股代码|rights|临时证券|临时代码|供股权证', ctx, re.I))
        is_ref_ctx = bool(re.search(r'换股|吸收合并|合并方|收购方|换股对象|被合并方|换股价格', ctx, re.I))
        if is_ref_ctx and code not in result['reference_codes']:
            result['reference_codes'].append(code)
            result['evidence'].append({'field': 'reference_code', 'value': code, 'pos': pos})
        elif is_rights_ctx and code not in result['rights_codes']:
            result['rights_codes'].append(code)
            result['evidence'].append({'field': 'rights_code', 'value': code, 'pos': pos})

    # 现金对价：遍历所有命中，取首个能解析出正数价格的
    # （避免首个关键词命中落在无关语境、其后无数字导致整条提取落空）
    # 若已知 target_code，对「换股价格」额外做上下文选择：优先取 target_code 附近的价格，
    # 避免在换股吸收合并报告书中取成合并方（如湘财股份 7.51）而非被合并方（如大智慧 9.53）的价格。
    cash_val = None
    cash_ev = None

    # 若已知 target_code，对「换股价格」做上下文选择，避免取成合并方价格。
    # 做法：根据 target_code 反查公司简称，再取该简称附近的「换股价格」。
    if target_code and cash_val is None:
        short_name = _infer_short_name_by_code(text, target_code)
        if short_name:
            best = None
            best_dist = float('inf')
            name_pat = re.compile(re.escape(short_name))
            for _m in RE_CASH_OFFER.finditer(text):
                kw = _m.group(0)[:40]
                if '换股' not in kw and '換股' not in kw:
                    continue
                _v = _to_num(_m.group(1))
                if _v is None or _v <= 0:
                    continue
                for nm in name_pat.finditer(text):
                    _dist = abs(_m.start() - nm.start())
                    if _dist < best_dist:
                        best_dist = _dist
                        best = (_v, _m)
            if best:
                cash_val, cash_m = best
                cash_ev = {'field': 'cash_offer_price', 'value': cash_m.group(1), 'pos': cash_m.start()}

    if cash_val is None:
        for _m in RE_CASH_OFFER.finditer(text):
            _v = _to_num(_m.group(1))
            if _v is not None and _v > 0:
                cash_val = _v
                cash_ev = {'field': 'cash_offer_price', 'value': _m.group(1), 'pos': _m.start()}
                break
    if cash_val is not None:
        result['cash_offer_price'] = cash_val
        result['evidence'].append(cash_ev)

    # 供股价
    m = RE_SUBSCRIPTION_PRICE.search(text)
    val = _to_num(m.group(1)) if m else None
    if val is not None and val > 0:
        result['subscription_price'] = val
        result['evidence'].append({'field': 'subscription_price', 'value': m.group(1), 'pos': m.start()})

    # 换股比例
    for _rex in (RE_SWAP_RATIO, RE_SWAP_RATIO2, RE_SWAP_RATIO3):
        m = _rex.search(text)
        if m:
            g1 = _to_num(m.group(1))
            g2 = _to_num(m.group(2))
            if g1 is not None and g2 is not None and g1 > 0 and g2 > 0:
                result['swap_ratio'] = round(g1 / g2, 6)
                result['evidence'].append({'field': 'swap_ratio', 'value': f'{m.group(1)}:{m.group(2)}', 'pos': m.start()})
                break

    # 现金补偿
    m = RE_CASH_COMP.search(text)
    val = _to_num(m.group(1)) if m else None
    if val is not None and val > 0:
        result['cash_component'] = val
        result['evidence'].append({'field': 'cash_component', 'value': m.group(1), 'pos': m.start()})

    # 供股比例
    m = RE_RIGHTS_RATIO.search(text)
    if m:
        g1 = _to_num(m.group(1))
        g2 = _to_num(m.group(2))
        if g1 is not None and g2 is not None and g1 > 0 and g2 > 0:
            result['rights_ratio_numerator'] = int(g1)
            result['rights_ratio_denominator'] = int(g2)
            result['evidence'].append({'field': 'rights_ratio', 'value': f'{m.group(1)}:{m.group(2)}', 'pos': m.start()})

    # 要约人
    m = RE_OFFEROR.search(text)
    if m:
        _off = m.group(1).strip()
        # 排除「一致行动人」等无关语境（A 股固定术语，非真正要约人）
        if '一致' not in _off:
            result['offeror'] = _off
            result['evidence'].append({'field': 'offeror', 'value': _off, 'pos': m.start()})

    # 持股比例
    m = RE_HOLDING_PCT.search(text)
    if m:
        result['offeror_holding_pct'] = float(m.group(1))
        result['evidence'].append({'field': 'offeror_holding_pct', 'value': m.group(1), 'pos': m.start()})

    # 日期
    for m in RE_DATE.finditer(text):
        d = f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
        if 'first_announcement' not in result['dates']:
            result['dates']['first_announcement'] = d

    # 置信度：基于提取到的关键字段数量
    key_fields = sum([
        bool(result['target_codes']),
        bool(result['cash_offer_price'] or result['subscription_price']),
        bool(result['swap_ratio']),
        bool(result['rights_ratio_numerator']),
        bool(result['offeror']),
    ])
    result['confidence'] = round(key_fields / 5.0, 2)

    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: extractArbitrageDocument.py <url_or_path> [--target-code CODE] [output.json]'}))
        sys.exit(1)

    source = sys.argv[1]
    target_code = None
    output_path = None
    i = 2
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '--target-code' and i + 1 < len(sys.argv):
            target_code = sys.argv[i + 1]
            i += 2
        elif output_path is None:
            output_path = arg
            i += 1
        else:
            i += 1

    temp_pdf = None
    file_path = source

    # 如果是 URL，先下载
    if source.startswith('http'):
        import tempfile
        temp_pdf = tempfile.mktemp(suffix='.pdf')
        ok, err = download_pdf(source, temp_pdf)
        if not ok:
            print(json.dumps({'error': f'Download failed: {err}'}))
            sys.exit(1)
        file_path = temp_pdf

    # 提取文本
    text, err = extract_text_from_pdf(file_path)
    if temp_pdf and os.path.exists(temp_pdf):
        os.remove(temp_pdf)

    if err:
        print(json.dumps({'error': f'PDF extraction failed: {err}'}))
        sys.exit(1)

    # 解析字段（即便单字段异常也尽可能返回已提取结果，绝不空输出导致同步崩溃）
    try:
        result = parse_fields(text, target_code=target_code)
    except Exception as e:
        result = {'error': 'parse_fields failed: ' + str(e), 'source': source}
    result['text_length'] = len(text) if text else 0
    result['source'] = source

    output = json.dumps(result, ensure_ascii=False, indent=2)
    if output_path:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f'Output written to {output_path}')
    else:
        print(output)


if __name__ == '__main__':
    main()
