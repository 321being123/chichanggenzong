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

# 证券代码（A股6位 / 港股5位）
RE_A_STOCK = re.compile(r'(?:证券代码|股票代码|代码)[:\s]*(\d{6})')
RE_HK_STOCK = re.compile(r'(?:股份代号|股票代码|Stock\s*Code)[:\s]*(\d{5})', re.I)

# 现金对价 / 注销价 / 供股价
RE_CASH_OFFER = re.compile(r'(?:现金对价|注销价|要约价|收购价|Offer\s*Price)[:\s]* hk?d?\s*([\d.]+)', re.I)
RE_SUBSCRIPTION_PRICE = re.compile(r'(?:供股价|认购价|Subscription\s*Price)[:\s]* hk?d?\s*([\d.]+)', re.I)

# 换股比例
RE_SWAP_RATIO = re.compile(r'(?:换股比例|换股比率|Exchange\s*Ratio)[:\s]*.*?(\d+\.?\d*)\s*(?:股|shares?)\s*(?:换|for)\s*(\d+\.?\d*)\s*(?:股|shares?)', re.I)

# 现金补偿
RE_CASH_COMP = re.compile(r'(?:现金补偿|每股现金|Cash\s*Component)[:\s]*([\d.]+)', re.I)

# 供股比例
RE_RIGHTS_RATIO = re.compile(r'(?:供股比例|认购比例|Basis\s*of\s*(?:Offering|Entitlement))[:\s]*.*?(\d+)\s*(?:股|for)\s*(\d+)\s*(?:股|shares?)', re.I)

# 日期
RE_DATE = re.compile(r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日')
RE_DATE_ISO = re.compile(r'(\d{4}-\d{2}-\d{2})')

# 要约人
RE_OFFEROR = re.compile(r'(?:要约人|Offeror|收购人)[:\s]*([^\n，,。.]{2,50})')

# 持股比例
RE_HOLDING_PCT = re.compile(r'(?:持股比例|持股量|Holding)[:\s]*([\d.]+)\s*%')

def parse_fields(text):
    """从全文中提取结构化字段"""
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

    # 主证券（发行人）：首个出现的代码
    if ordered_codes:
        result['target_codes'].append(ordered_codes[0])
        result['evidence'].append({'field': 'target_code', 'value': ordered_codes[0], 'pos': code_hits[0][0]})

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

    # 现金对价
    m = RE_CASH_OFFER.search(text)
    if m:
        result['cash_offer_price'] = float(m.group(1))
        result['evidence'].append({'field': 'cash_offer_price', 'value': m.group(1), 'pos': m.start()})

    # 供股价
    m = RE_SUBSCRIPTION_PRICE.search(text)
    if m:
        result['subscription_price'] = float(m.group(1))
        result['evidence'].append({'field': 'subscription_price', 'value': m.group(1), 'pos': m.start()})

    # 换股比例
    m = RE_SWAP_RATIO.search(text)
    if m:
        result['swap_ratio'] = float(m.group(1)) / float(m.group(2)) if float(m.group(2)) != 0 else None
        result['evidence'].append({'field': 'swap_ratio', 'value': f'{m.group(1)}:{m.group(2)}', 'pos': m.start()})

    # 现金补偿
    m = RE_CASH_COMP.search(text)
    if m:
        result['cash_component'] = float(m.group(1))
        result['evidence'].append({'field': 'cash_component', 'value': m.group(1), 'pos': m.start()})

    # 供股比例
    m = RE_RIGHTS_RATIO.search(text)
    if m:
        result['rights_ratio_numerator'] = int(m.group(1))
        result['rights_ratio_denominator'] = int(m.group(2))
        result['evidence'].append({'field': 'rights_ratio', 'value': f'{m.group(1)}:{m.group(2)}', 'pos': m.start()})

    # 要约人
    m = RE_OFFEROR.search(text)
    if m:
        result['offeror'] = m.group(1).strip()
        result['evidence'].append({'field': 'offeror', 'value': m.group(1), 'pos': m.start()})

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
        print(json.dumps({'error': 'Usage: extractArbitrageDocument.py <url_or_path> [output.json]'}))
        sys.exit(1)

    source = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None

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

    # 解析字段
    result = parse_fields(text)
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
