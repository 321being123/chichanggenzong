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
RE_HK_STOCK = re.compile(r'(?:股份代號|股份代号|供股權?代號|供股权?代号|供股權?代碼|供股权?代码|Stock\s*Code)[:：\s]*(\d{3,5})', re.I)

# 现金对价 / 注销价 / 要约价 / 收购价。换股价格必须由独立规则提取，禁止混入现金字段。
RE_CASH_OFFER = re.compile(
    r'(?:現金對價|现金对价|'
    r'現金選擇權價格|现金选择权价格|異議股東收購請求權價格|异议股东收购请求权价格|'
    r'註銷價|注销价|注銷價|'
    r'要約收購(?:的)?價格|要约收购(?:的)?价格|'
    r'要約(?:的)?價格|要约(?:的)?价格|要約(?:的)?價|要约(?:的)?价|'
    r'收購(?:的)?價格|收购(?:的)?价格|收購(?:的)?價|收购(?:的)?价|收購(?:的)?價款|收购(?:的)?价款|'
    r'現金代價|现金代价)'
            r'[\s:：]*'                              # 冒号/空格
    r'(?:為|为|是)?'                         # 为/是（简繁兼容）
    r'的?'                                   # 的（如「价格为的」/「价格为」）
    r'[\s:：]*'                              # 更多空格/冒号
    r'(?:每?股)?'                            # 可选「每股」
    r'(?:港幣|港元|港币|HK\$?|HKD|人民幣|人民币|RMB)?'  # 货币
    r'\s*'
    r'([\d.]+)', re.I)

# 吸收合并双方的现金退出权可能分别写作“收购请求权”或“现金选择权”，且价格与关键词之间
# 常夹有“定价基准日前120个交易日均价”等长说明，不能只依赖关键词后紧跟数字的短格式。
RE_NAMED_CASH_RIGHT = re.compile(
    r'(?:異議股東|异议股东)?(?:收購請求權|收购请求权|現金選擇權|现金选择权)(?:的)?(?:價格|价格)'
    r'[^。；]{0,260}?(\d+(?:\.\d+)?)\s*元\s*(?:/|／)?\s*股', re.I)

# 港股私有化复合对价：部分方案除现金选择外还实物分派另一家公司股份，
# 公告会同时披露「现金选择」和包含分派估值的「每股理论总额」。
RE_HK_SCHEME_CASH = re.compile(
    r'(?:現金選擇|现金选择)[\s\S]{0,100}?每股計劃股份[\s\S]{0,50}?'
    r'(?:港幣|港元|港币)\s*([\d.]+)\s*元?', re.I)
RE_HK_THEORETICAL_TOTAL = re.compile(
    r'每股計劃股份(?:的)?理論總額[\s\S]{0,40}?'
    r'(?:約|约)?\s*(?:港幣|港元|港币)\s*([\d.]+)\s*元?', re.I)
RE_HK_DISTRIBUTION = re.compile(
    r'每股(?:計劃)?股份[\s\S]{0,30}?獲發\s*([\d.]+)\s*股\s*([一-鿿]{2,20}股份)', re.I)
RE_HK_CANCELLATION_PRICE = re.compile(
    r'(?:每股計劃股份)?\s*現金註銷價\s*([\d.]+)\s*港元', re.I)

# B股转H股现金选择权：「具体的价格为每股12.68元港币」
RE_B_SHARE_CASH_EXACT = re.compile(
    r'(?:具體的價格|具体的价格)\s*(?:為|为)?\s*每股\s*([\d.]+)\s*(?:元港幣|元港币|港元|港幣|港币)', re.I)
RE_B_SHARE_CASH = re.compile(
    r'(?:現金選擇權|现金选择权)[\s\S]{0,50}?'
    r'(?:為|为)?\s*每股\s*([\d.]+)\s*(?:元港幣|元港币|港元|港幣|港币)', re.I)

RE_ISSUER_ANNOUNCEMENT = re.compile(r'([一-鿿]{2,30}有限公司)\s*公告')
RE_ISSUER_AFTER_STOCK_CODE = re.compile(
    r'(?:股份代號|股份代号)[:：\s]*\d{3,5}[\s\S]{0,100}?([一-鿿]{2,30}有限公司)')
# 供股价格 / 认购价 —— 「認購價為每股供股股份港幣6.25元」
RE_SUBSCRIPTION_PRICE = re.compile(
    r'(?:認購價|认购价|供股價|供股价|認購價格|认购价格|供股價格|供股价格)'
    r'[:：\s]*(?:為|为|是)?[:：\s]*(?:每?股[^\d]{0,15}?)?'
    r'(?:港幣|港元|港币|HK\$|HKD)?\s*([\d.]+)', re.I)

# 供股价备选（无关键词前导）：「每股供股股份0.30 港元」
RE_SUBSCRIPTION_PRICE2 = re.compile(
    r'每股供股股份\s*(?:約|约)?\s*(?:港幣|港元|港币|HK\$)?\s*([\d.]+)\s*(?:港元|元)', re.I)

# 港股供股权日期 —— 中文日期「二零二X年X月X日」
RE_CN_DATE = re.compile(r'二零二([五六七八九])年([一二三四五六七八九十]{1,2})月([一二三四五六七八九十]{1,2})日')
# 供股权交易期：「於...上午九時正至...下午四時正期間」（零碎股份/未缴股款供股股份买卖期）
RE_RIGHTS_TRADE_PERIOD = re.compile(
    r'上午九時正[\s\S]{0,200}下午四時正[\s\S]{0,20}期間', re.I)
# 付款截止（最後接納時限）：「最後接納時限.*?二零二X年X月X日」
RE_RIGHTS_DEADLINE = re.compile(
    r'最後接納時限[\s\S]{0,80}?二零二[五六七八九]年[一二三四五六七八九十]{1,2}月[一二三四五六七八九十]{1,2}日', re.I)

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

# 要约人：港股私有化公告开头是法律免责声明，里面也含「要約人」三字（如「要約人或本公司證券的邀請…」），
# 真正的要约人名称紧跟在免责声明结尾之后。故先定位免责声明结尾，再抓其后的公司名。
# 免责声明结尾标志（覆盖不同公告变体）：分發。/分派。/要約人或本公司證券。
# PDF 抽取常在「證」「券」间插入空格，故容忍要約人/本公司/證券之间的空白。
RE_DISCLAIMER_END = re.compile(
    r'(?:'
    r'分發。'
    r'|分派。'
    r'|要約人\s*或\s*本公司\s*證\s*券\s*(?:之\s*邀請\s*或\s*要約)?\s*[。.]?'
    r')')
# 免责声明之后的公司名：英文（Xxx Limited / Holdings …）或中文（XX控股/投資/能源/金融/證券/股份 有限公司）
RE_COMPANY_AFTER = re.compile(
    r'([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*(?:\s+(?:Limited|LIMITED|Holdings|HOLDINGS|Capital|CAPITAL|'
    r'Group|GROUP|International|INTERNATIONAL|Agents|AGENTS|Investment|INVESTMENT))'
    r'|[一-鿿]+(?:控股|集團|投資|能源|金融|證券|企業|股份)?有限公司?)')
# A 股等其他场景的兜底：要約人/收購方：XXX（不含法律声明碎片）
RE_OFFEROR = re.compile(r'(?:要約人|要约人|收購人|收购人|收購方|收购方)[:：\s]*(?:為|为|是)?[:：\s]*([^，。\n]{2,30})')
RE_BUYBACK_ISSUER = re.compile(r'([一-鿿]{2,30}有限公司)[\s\S]{0,120}?(?:股份回購計劃|股份回购计划)')

# 持股比例
RE_HOLDING_PCT = re.compile(r'(?:持股比例|持股量|持股百分比|Holding)[:：\s]*(?:為|为|是)?[:：\s]*([\d.]+)\s*%')

# 换股吸收合并结构：「X换股吸收合并Y」→ X=收购方，Y=被合并方（最可靠的方向识别信号，与代码出现顺序无关）
# PDF 正文抽取常把公司名与「换股吸收合并」用换行/空格拆开，故用窗口法（见 _find_merge_pair）而非单条正则。
# 各公司换股价格（按公司简称）：「湘财股份的A股换股价格为7.51元/股」「中国船舶换股价格为37.59元/股」
# 「经除权除息后的中国船舶换股价格为37.59元/股」（前导分红表述在代码里剥离，只留公司简称；价格为后允许空格）。
RE_SWAP_PRICE = re.compile(
    r'([\u4e00-\u9fa5A-Za-z·]{2,20}?)的?\s*(?:(?:A\s*股)?\s*股票|A\s*股)?\s*换股价格为\s*([\d.]+)')
# 价格与公司名之间有少量间隔（如「中国船舶召开董事会审议换股价格为37.59」「…的换股价格…确定为37.84」）
RE_SWAP_PRICE2 = re.compile(r'([\u4e00-\u9fa5·]{2,12}(?:股份有限公司|公司|集团)?).{0,40}?换股价格\s*(?:为|确定)\s*([\d.]+)')
# 具名换股比例：「每7.46826股中国重工股票换1股中国船舶股票」「每1股中国重工股票将转换为0.1339股中国船舶」
# 公司名排除 股/票（属「股票」而非公司名），并贪心取全名，避免中间 .{0,12}? 吞掉公司名。
RE_SWAP_NAMED = re.compile(
    r'每\s*(\d+\.?\d*)\s*股\s*([\u4e00-\u9fa5·]{2,12})(?:\s*A\s*股)?\s*股票?'
    r'.{0,20}?(?:可以|可|将)?(?:换取|换|获配|获得|转换为)\s*'
    r'(\d+\.?\d*)\s*股\s*([\u4e00-\u9fa5·]{2,12})(?:\s*A\s*股)?\s*股票?')
# 公司名（以 股份有限公司/公司/集团 收尾），用于窗口法识别收购方/被合并方
RE_COMPANY = re.compile(r'([\u4e00-\u9fa5·]{2,12}(?:股份有限公司|公司|集团))')

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

def _norm_name(n):
    """公司简称归一化：去掉股份/有限公司/括号/间隔号/股票等，便于按名匹配。"""
    if not n:
        return ''
    for s in ['股份有限公司', '有限责任公司', '有限公司', '股份', '股票', '（', '）', '(', ')', ' ', '・', '·']:
        n = n.replace(s, '')
    return n.strip()

def _flex_name_pattern(n):
    """公司简称的 PDF 文本常被随机插入空格，生成逐字容忍空白的安全正则。"""
    return r'\s*'.join(re.escape(ch) for ch in n) if n else ''

def _match_price(swap_prices, name):
    """在 {公司简称: 换股价格} 中按名精确/包含匹配取价格。"""
    if not name:
        return None
    if name in swap_prices:
        return swap_prices[name]
    for k, v in swap_prices.items():
        if k and (k in name or name in k):
            return v
    return None

def _match_key(swap_prices, name):
    """返回 swap_prices 中与 name 匹配到的 key（用于回写收购方简称）。"""
    if not name:
        return None
    if name in swap_prices:
        return name
    for k in swap_prices:
        if k and (k in name or name in k):
            return k
    return None

def _find_absorber(text):
    """识别换股吸收合并的收购方（absorber）归一化短名。

    优先用「X以向…发行A股股票的方式换股吸收合并Y」——X 即为收购方，且取到的就是公告里的精确短名；
    兜底用窗口法：首个「换股吸收合并」之前 40 字内最后一个公司名。
    """
    m = re.search(r'([\u4e00-\u9fa5·]{2,12}(?:股份有限公司|公司|集团)?)以向', text)
    if m:
        # 去掉「拟/将/等」等修饰字（如「中国船舶拟以向…」）
        return _norm_name(re.sub(r'[拟将决定计划等]$', '', m.group(1)))
    mm = re.search(r'换股吸收合并', text)
    if not mm:
        return None
    before = text[max(0, mm.start() - 40):mm.start()]
    co = list(RE_COMPANY.finditer(before))
    return _norm_name(co[-1].group(1)) if co else None

def _find_named_ratio(text, target_name=None):
    """从具名比例「每X股A换/转换为Y股B」提取 (ca, cb, g1n, g2n, pos)。

    标准 A 股写法恒为「每X股被合并方 → Y股收购方」，故：
    - 收购方 = B（cb），换股比例（被合并方价÷收购方价）= Y/X = g2/g1，与 target_code 无关。
    仅在结构识别出的收购方恰好是 A（罕见反向写法）时才取倒数。
    """
    m_struct = re.search(r'换股吸收合并', text)
    absorber_norm = None
    if m_struct:
        before = text[max(0, m_struct.start() - 40):m_struct.start()]
        cb_before = list(RE_COMPANY.finditer(before))
        absorber_norm = _norm_name(cb_before[-1].group(1)) if cb_before else None
    fallback = None
    for _nm in RE_SWAP_NAMED.finditer(text):
        g1n = _to_num(_nm.group(1))
        ca = _norm_name(_nm.group(2))
        g2n = _to_num(_nm.group(3))
        cb = _norm_name(_nm.group(4))
        if not (g1n and g2n and g1n > 0 and g2n > 0):
            continue
        # 收购方默认为 cb（标准写法）；若结构识别的收购方是 A，则反向
        absorber_is_ca = bool(absorber_norm and (ca == absorber_norm or absorber_norm in ca or ca in absorber_norm))
        hit = (ca, cb, g1n, g2n, absorber_is_ca, _nm.start())
        if fallback is None:
            fallback = hit
        if target_name and (ca == target_name or ca in target_name or target_name in ca):
            return hit
    return None if target_name else fallback

def _find_ratio_for_target(text, target_name):
    """提取“目标公司…换股比例为1:X”中的 X，解决一个合并方同时吸收多家公司的不同比例。"""
    if not target_name:
        return None
    patterns = [
        re.compile(
            re.escape(target_name) + r'[^。；]{0,40}?(?:与|與|和)[^。；]{1,30}?(?:换股比例|換股比例|换股比率|換股比率)'
            r'.{0,20}?(\d+\.?\d*)\s*[:：]\s*(\d+\.?\d*)'),
        re.compile(
            r'每\s*(\d+\.?\d*)\s*股\s*' + re.escape(target_name)
            + r'.{0,40}?(?:换取|換取|换得|換得|可换|可換)\s*(\d+\.?\d*)\s*股'),
    ]
    for pat in patterns:
        for m in pat.finditer(text):
            g1 = _to_num(m.group(1))
            g2 = _to_num(m.group(2))
            if g1 and g2 and g1 > 0 and g2 > 0:
                return round(g2 / g1, 6), m.start()
    return None

def _find_code_for_name(text, name):
    """从“公司全称…A股股票代码：xxxxxx”定义段提取代码，解决全称与证券简称不一致。"""
    if not name:
        return None
    a = re.search(
        re.escape(name) + r'[^。；]{0,180}?(?:A\s*股)?(?:股票代码|证券代码|股票代碼|證券代碼)'
        r'[:：\s]*(\d{6})', text)
    if a:
        return a.group(1)
    hk = re.search(
        re.escape(name) + r'[^。；]{0,180}?(?:股份代号|股份代號|Stock\s*Code)'
        r'[:：\s]*(\d{3,5})', text, re.I)
    return hk.group(1) if hk else None

def _infer_short_name_by_code(text, code):
    """根据证券代码在文本中反查公司简称（支持代码在前/简称在前两种排版，分隔符可缺省）。"""
    pat = re.compile(
        r'(?:股票代码|证券代码|代碼|代码)[:：\s]*' + re.escape(code) + r'(?:\.\w+)?.{0,80}?(?:股票简称|证券简称|股票簡稱)[:：\s]*([^\s，。；、:：]{2,20})',
        re.I | re.S)
    m = pat.search(text)
    if m:
        return m.group(1).strip()
    pat2 = re.compile(
        r'(?:股票简称|证券简称|股票簡稱)[:：\s]*([^\s，。；、:：]{2,20}).{0,80}?(?:股票代码|证券代码|代碼|代码)[:：\s]*' + re.escape(code),
        re.I | re.S)
    m2 = pat2.search(text)
    if m2:
        return m2.group(1).strip()
    return None


def _cn_yy(s):
    return {"五":"25","六":"26","七":"27","八":"28","九":"29"}.get(s, s)

def _cn_num(s):
    m = {"零":0,"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10,
       "十一":11,"十二":12,"十三":13,"十四":14,"十五":15,"十六":16,"十七":17,"十八":18,"十九":19,
       "二十":20,"二十一":21,"二十二":22,"二十三":23,"二十四":24,"二十五":25,"二十六":26,
       "二十七":27,"二十八":28,"二十九":29,"三十":30}
    if s in m: return str(m[s])
    n = 0
    for ch in s:
        if ch in m and m[ch] < 10: n = n * 10 + m[ch]
        elif ch == "十": n = n * 10 if n > 0 else 10
    return str(n) if n > 0 else s

def parse_fields(text, target_code=None):
    """从全文中提取结构化字段。

    target_code: 若已知目标证券代码（如 A 股换股吸收合并中的被吸收合并方），
                 会优先提取该代码附近的「换股价格」，并把该代码排在 target_codes 首位。
    """
    result = {
        'target_codes': [],
        'observed_codes': [],
        'target_code_match': None,
        'reference_codes': [],
        'reference_names': [],
        'rights_codes': [],
        'cash_offer_price': None,
        'cash_choice_price': None,
        'target_swap_price': None,
        'reference_swap_price': None,
        'subscription_price': None,
        'swap_ratio': None,
        'cash_component': None,
        'consideration_note': None,
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

    # 归一化空白：PDF 抽取常在「公司名」与「换股价格」之间插入换行，
    # 导致跨行无法匹配；压成单空格不影响其他正则（它们都用 \s*）。
    text = re.sub(r'\s+', ' ', text)

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

    result['observed_codes'] = list(ordered_codes)
    if target_code and re.fullmatch(r'\d{5,6}', str(target_code)):
        result['target_code_match'] = str(target_code) in ordered_codes

    # 若调用方已告知目标证券代码，将其置顶，避免从财务顾问报告/合并方段落里取错价格
    if target_code and re.fullmatch(r'\d{5,6}', str(target_code)):
        if target_code in ordered_codes:
            ordered_codes.remove(target_code)
        ordered_codes.insert(0, target_code)

    # 主证券（发行人）：首个出现的代码
    if ordered_codes:
        result['target_codes'].append(ordered_codes[0])
        first_pos = next((pos for pos, code in code_hits if code == ordered_codes[0]), code_hits[0][0] if code_hits else 0)
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
    # 若已知 target_code，按目标公司简称选择距离最近的现金条款，避免多标的合并互相串价。
    cash_val = None
    cash_ev = None

    # 做法：根据 target_code 反查公司简称，再取该简称附近的现金选择权/要约价格。
    if target_code and cash_val is None:
        short_name = _infer_short_name_by_code(text, target_code)
        if short_name:
            best = None
            best_dist = float('inf')
            name_pat = re.compile(re.escape(short_name))
            for _m in RE_CASH_OFFER.finditer(text):
                _v = _to_num(_m.group(1))
                if _v is None or _v <= 0:
                    continue
                for nm in name_pat.finditer(text):
                    _dist = abs(_m.start() - nm.start())
                    if _dist <= 1000 and _dist < best_dist:
                        best_dist = _dist
                        best = (_v, _m)
            if best:
                cash_val, cash_m = best
                cash_ev = {'field': 'cash_offer_price', 'value': cash_m.group(1), 'pos': cash_m.start()}

            # 长句格式必须同时在现金权关键词前出现目标公司简称，防止多标的报告串价。
            named_best = None
            named_best_dist = float('inf')
            for _m in RE_NAMED_CASH_RIGHT.finditer(text):
                _before = text[max(0, _m.start() - 80):_m.start()]
                _name_hits = list(re.finditer(_flex_name_pattern(short_name), _before))
                if _name_hits:
                    _name_dist = len(_before) - _name_hits[-1].end()
                    _v = _to_num(_m.group(1))
                    if _v is not None and 0 < _v < 1000 and _name_dist < named_best_dist:
                        named_best = (_v, _m)
                        named_best_dist = _name_dist
            if named_best:
                cash_val, cash_m = named_best
                cash_ev = {'field': 'cash_offer_price', 'value': cash_m.group(1), 'pos': cash_m.start()}

    if cash_val is None:
        for _m in RE_CASH_OFFER.finditer(text):
            _v = _to_num(_m.group(1))
            if _v is not None and _v > 0:
                cash_val = _v
                cash_ev = {'field': 'cash_offer_price', 'value': _m.group(1), 'pos': _m.start()}
                break
    # 同一报告可能同时保留初始价和除权除息后的现行价；目标公司具名的“调整为”条款优先。
    if target_code:
        short_name = _infer_short_name_by_code(text, target_code)
        if short_name:
            adjusted_patterns = [
                re.compile(
                    _flex_name_pattern(short_name) + r'\s*A\s*股[^。；]{0,120}?'
                    r'(?:异议股东)?(?:收购请求权|现金选择权)价格\s*(?:已)?调整\s*为\s*每?股?\s*([\d.]+)'
                ),
                re.compile(
                    _flex_name_pattern(short_name) +
                    r'[^。；]{0,180}?(?:异议股东)?(?:收购请求权|现金选择权)价格\s*(?:已)?调整\s*为\s*每?股?\s*([\d.]+)'
                ),
            ]
            for pattern_index, adjusted_cash in enumerate(adjusted_patterns):
                adjusted_matches = list(adjusted_cash.finditer(text))
                if adjusted_matches:
                    # A/H 股可能在同一长句分别列价；A 股专用模式取首个，避免越过 A 股价格串到 H 股。
                    cash_m = adjusted_matches[0] if pattern_index == 0 else adjusted_matches[-1]
                    cash_val = _to_num(cash_m.group(1))
                    cash_ev = {'field': 'cash_offer_price', 'value': cash_m.group(1), 'pos': cash_m.start()}
                    break
    if cash_val is not None:
        result['cash_offer_price'] = cash_val
        result['evidence'].append(cash_ev)

    # 港股计划安排的「现金注销价」优先于正文后部的购股权行使价/透视价。
    cancellation_m = RE_HK_CANCELLATION_PRICE.search(text)
    cancellation_price = _to_num(cancellation_m.group(1)) if cancellation_m else None
    if cancellation_price is not None and cancellation_price > 0:
        result['cash_offer_price'] = cancellation_price
        result['cash_choice_price'] = cancellation_price
        result['evidence'].append({'field': 'cash_offer_price', 'value': cancellation_m.group(1), 'pos': cancellation_m.start()})

    b_cash_m = RE_B_SHARE_CASH_EXACT.search(text) or RE_B_SHARE_CASH.search(text)
    b_cash = _to_num(b_cash_m.group(1)) if b_cash_m else None
    if b_cash is not None and b_cash > 0:
        result['cash_offer_price'] = b_cash
        result['cash_choice_price'] = b_cash
        result['evidence'].append({'field': 'cash_offer_price', 'value': b_cash_m.group(1), 'pos': b_cash_m.start()})

    # 复合私有化对价：套利只按可确定的现金选择计算；公司对实物分派的估值仅作备注。
    scheme_cash_m = RE_HK_SCHEME_CASH.search(text)
    scheme_total_m = RE_HK_THEORETICAL_TOTAL.search(text)
    scheme_cash = _to_num(scheme_cash_m.group(1)) if scheme_cash_m else None
    scheme_total = _to_num(scheme_total_m.group(1)) if scheme_total_m else None
    if scheme_cash is not None and scheme_cash > 0:
        result['cash_offer_price'] = scheme_cash
        result['cash_choice_price'] = scheme_cash
        result['evidence'].append({'field': 'cash_choice_price', 'value': scheme_cash_m.group(1), 'pos': scheme_cash_m.start()})
    if scheme_total is not None and scheme_total > 0 and scheme_cash is not None:
        dist_m = RE_HK_DISTRIBUTION.search(text)
        dist_text = ''
        if dist_m:
            dist_text = f'；另每股获发{dist_m.group(1)}股{dist_m.group(2)}'
        result['consideration_note'] = (
            f'现金选择为每股{scheme_cash:g}港元{dist_text}。'
            f'公告按公司估值测算每股理论总额约{scheme_total:g}港元，仅作参考，不用于套利空间计算。'
        )
        result['evidence'].append({'field': 'company_theoretical_total', 'value': scheme_total_m.group(1), 'pos': scheme_total_m.start()})

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
                result['swap_ratio'] = round(g2 / g1, 6)  # A股标准：每X股被合并方换Y股收购方，比例=Y/X=g2/g1
                result['evidence'].append({'field': 'swap_ratio', 'value': f'{m.group(1)}:{m.group(2)}', 'pos': m.start()})
                break
    explicit_swap_ratio = result['swap_ratio']
    target_name_for_ratio = _norm_name(_infer_short_name_by_code(text, target_code)) if target_code else None
    target_ratio = _find_ratio_for_target(text, target_name_for_ratio)
    if target_ratio:
        result['swap_ratio'] = target_ratio[0]
        result['evidence'].append({'field': 'swap_ratio', 'value': f'target_named {target_ratio[0]}', 'pos': target_ratio[1]})

    # 换股吸收合并定向：换股比例统一为「被合并方换股价格 ÷ 收购方换股价格」
    # （1 股被合并方可换得的收购方股数），与代码出现顺序、target_code 取值无关，从根本上避免方向存反。
    if '吸收合并' in text:
        # 收集各公司换股价格（按简称；剥离前导分红表述如「经除权除息后的」）
        swap_prices = {}
        for _sm in RE_SWAP_PRICE.finditer(text):
            raw = _sm.group(1)
            nm = _norm_name(raw.split('的')[-1].split('后')[-1])
            if nm:
                # 报告书开头的交易摘要披露当前有效价格；后文常重复历史价格，不能反向覆盖。
                swap_prices.setdefault(nm, float(_sm.group(2)))
        for _sm in RE_SWAP_PRICE2.finditer(text):
            nm = _norm_name(_sm.group(1))
            if nm:
                swap_prices.setdefault(nm, float(_sm.group(2)))

        target_name = target_name_for_ratio
        named = _find_named_ratio(text, target_name)
        absorber_norm = _find_absorber(text)
        if not absorber_norm and named:
            ca, cb, _, _, absorber_is_ca, _ = named
            absorber_norm = ca if absorber_is_ca else cb
        # 利润分配后的具名调整价是当前有效值，优先覆盖报告中保留的初始换股价。
        if target_name:
            adjusted_swap = re.compile(
                _flex_name_pattern(target_name) + r'的?\s*(?:A\s*股)?\s*换股价格\s*(?:已)?调整\s*为\s*([\d.]+)')
            adjusted_matches = list(adjusted_swap.finditer(text))
            if adjusted_matches:
                swap_prices[target_name] = float(adjusted_matches[-1].group(1))
        absorber_price = _match_price(swap_prices, absorber_norm)
        target_price = _match_price(swap_prices, target_name)

        # 全称（如“中国国际金融”）与证券简称（如“中金公司”）不一定能直接互相包含，
        # 通过收购方代码反查证券简称后再匹配其当前换股价格。
        absorber_code = _find_code_for_name(text, absorber_norm) if absorber_norm else None
        absorber_short = _norm_name(_infer_short_name_by_code(text, absorber_code)) if absorber_code else None
        false_self_reference = bool(
            absorber_code and target_code and str(absorber_code) == str(target_code)
            and target_name and absorber_norm
            and not (target_name in absorber_norm or absorber_norm in target_name)
        )
        if false_self_reference:
            absorber_code = None
            absorber_short = None
            absorber_price = None
            if explicit_swap_ratio:
                result['swap_ratio'] = explicit_swap_ratio
        if not absorber_price and absorber_short:
            absorber_price = _match_price(swap_prices, absorber_short)
        for absorber_name in [absorber_short, absorber_norm]:
            if not absorber_name:
                continue
            absorber_adjusted = list(re.finditer(
                _flex_name_pattern(absorber_name) + r'的?\s*(?:A\s*股)?\s*换股价格\s*(?:已)?调整\s*为\s*([\d.]+)', text))
            if absorber_adjusted:
                absorber_price = float(absorber_adjusted[-1].group(1))
                break

        if target_price:
            result['target_swap_price'] = target_price
            result['evidence'].append({'field': 'target_swap_price', 'value': target_price, 'pos': 0})
        if absorber_price:
            result['reference_swap_price'] = absorber_price
            result['evidence'].append({'field': 'reference_swap_price', 'value': absorber_price, 'pos': 0})

        if absorber_norm:
            result['reference_codes'] = [absorber_code] if absorber_code else []
            if absorber_norm not in result['reference_names']:
                result['reference_names'].append(absorber_norm)

        # 已知目标代码时，必须按该目标公司的换股价格定向计算；多标的合并不能套用正文第一组比例。
        # 参考证券永远是合并方。若目标本身就是合并方，会得到 reference=target，公开列表据此排除。
        if target_code and absorber_norm and absorber_price and target_price:
            result['swap_ratio'] = round(target_price / absorber_price, 6)
            result['evidence'].append({
                'field': 'swap_ratio',
                'value': f'target {target_price}/{absorber_price}',
                'pos': 0,
            })
        # 未提供目标代码时，才使用正文中的第一组具名比例兜底。
        elif not target_code and named:
            ca, cb, g1n, g2n, absorber_is_ca, pos = named
            # 标准 A 股换股吸收合并写法恒为「每X股被合并方 → Y股收购方」，方向自包含：
            # 换股比例（被合并方→收购方股数）= Y/X = g2/g1，收购方简称=cb，不依赖 target_code 或 absorber 窗口判断。
            result['swap_ratio'] = round(g2n / g1n, 6)
            ref_name = cb
            result['evidence'].append({'field': 'swap_ratio', 'value': f'named {g1n}:{g2n}', 'pos': pos})
            if ref_name and ref_name not in result['reference_names']:
                result['reference_names'].append(ref_name)
        else:
            # 否则用收购方（absorber）识别 + 双方换股价格
            if absorber_norm and len(swap_prices) >= 2:
                abs_key = _match_key(swap_prices, absorber_norm)
                absorber_price = swap_prices.get(abs_key) if abs_key else None
                # 被合并方价格 = 其余不等于收购方价格的那个（两方合并通常恰好两个价格）
                other = [k for k in swap_prices if k != abs_key]
                absorbee_price = None
                if len(other) == 1:
                    absorbee_price = swap_prices[other[0]]
                elif len(other) > 1 and absorber_price is not None:
                    absorbee_price = next((swap_prices[k] for k in other if abs(absorber_price - swap_prices[k]) > 1e-9), None)
                if absorber_price and absorbee_price and absorber_price > 0:
                    result['swap_ratio'] = round(absorbee_price / absorber_price, 6)
                    result['evidence'].append({'field': 'swap_ratio', 'value': f'struct {absorbee_price}/{absorber_price}', 'pos': 0})
                    if abs_key and abs_key not in result['reference_names']:
                        result['reference_names'].append(abs_key)

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
            units = g1 / g2
            if abs(units - round(units)) < 1e-9:
                result['rights_units_per_new_share'] = int(round(units))
            result['evidence'].append({'field': 'rights_ratio', 'value': f'{m.group(1)}:{m.group(2)}', 'pos': m.start()})

    # 要约人：优先用「免责声明结尾之后紧接的公司名」策略（港股私有化最可靠）
    # 免责声明标志（分發。/分派。/要約人或本公司證券。）在正文里也可能出现，
    # 故遍历所有候选，只取「其后紧跟公司名」的那个（真正的要约人必紧跟开头声明）。
    _off = None
    _off_pos = None
    for m_end in RE_DISCLAIMER_END.finditer(text):
        _after = text[m_end.end():m_end.end() + 80]
        m_co = RE_COMPANY_AFTER.search(_after)
        if m_co:
            _off = m_co.group(1).strip()
            _off_pos = m_end.end() + m_co.start()
            break
    # 兜底：A 股等场景直接用「要約人：XXX」格式
    if not _off:
        m = RE_OFFEROR.search(text)
        if m:
            _cand = m.group(1).strip()
            if '一致' not in _cand and '司法' not in _cand and '邀請' not in _cand and '招攬' not in _cand:
                _off = _cand
                _off_pos = m.start()
    # 股份回购计划由上市公司本身支付现金代价，页面的「要约人」列展示该回购主体。
    if '股份回購計劃' in text or '股份回购计划' in text:
        m_issuer = RE_BUYBACK_ISSUER.search(text) or RE_ISSUER_ANNOUNCEMENT.search(text) or RE_ISSUER_AFTER_STOCK_CODE.search(text)
        _off = m_issuer.group(1).strip() if m_issuer else None
        _off_pos = m_issuer.start(1) if m_issuer else None
        result['clear_offeror'] = not bool(_off)
        result['clear_offeror_holding_pct'] = True
    if _off:
        result['offeror'] = _off
        result['evidence'].append({'field': 'offeror', 'value': _off, 'pos': _off_pos})

    # 持股比例
    m = RE_HOLDING_PCT.search(text)
    if m and '股份回購計劃' not in text:
        result['offeror_holding_pct'] = float(m.group(1))
        result['evidence'].append({'field': 'offeror_holding_pct', 'value': m.group(1), 'pos': m.start()})

    # 日期
    for m in RE_DATE.finditer(text):
        d = f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
        if 'first_announcement' not in result['dates']:
            result['dates']['first_announcement'] = d


    # 供股权专用日期（中文日期格式）
    _cn_dates = {}
    for dm in RE_CN_DATE.finditer(text):
        _ds = "20" + _cn_yy(dm.group(1)) + "-" + _cn_num(dm.group(2)) + "-" + _cn_num(dm.group(3))
        if "first_announcement" not in _cn_dates:
            _cn_dates["first_announcement"] = _ds
    if _cn_dates:
        result["dates"].update(_cn_dates)

    # 供股权交易期 / 付款截止 —— 稳健提取（支持中文数字年/数字年/缺年）
    _doc_year = _infer_doc_year(text)

    # 交易期：上午九時正 ... 下午四時正 期間 附近的成对日期（需两个不同日期才填）
    m_rp = RE_RIGHTS_TRADE_PERIOD.search(text)
    if m_rp:
        _rp_ctx = text[max(0,m_rp.start()-120):m_rp.start()+200]
        _uniq = []
        for d in _find_all_dates(_rp_ctx, _doc_year):
            if d not in _uniq:
                _uniq.append(d)
        if len(_uniq) >= 2:
            result["rights_trade_start"] = _uniq[0]
            result["rights_trade_end"] = _uniq[1]

    # 付款截止
    _dl = _find_rights_deadline(text, _doc_year)
    if _dl:
        result["payment_deadline"] = _dl
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




def _infer_doc_year(text):
    """从公告文本推断年份，用于补「缺年」的日期（如「十月二十七日」补成 2025-10-27）"""
    m = re.search(r'二零二([五六七八九])年', text)
    if m:
        return "20" + _cn_yy(m.group(1))
    m = re.search(r'(20[0-9]{2})\s*年', text)
    if m:
        return m.group(1)
    return None


def _extract_first_date(seg, doc_year=None):
    """在片段中找第一个日期，支持：数字年 / 中文数字年 / 缺年(用 doc_year 补)"""
    # 1) 数字年：2025年9月17日
    m = re.search(r'(20[0-9]{2})\s*年\s*([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日', seg)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    # 2) 中文数字年：二零二五年九月十七日
    m = re.search(r'二零二([五六七八九])年([一二三四五六七八九十]{1,2})月([一二三四五六七八九十]{1,2})日', seg)
    if m:
        return "20" + _cn_yy(m.group(1)) + "-" + _cn_num(m.group(2)) + "-" + _cn_num(m.group(3))
    # 3) 缺年（仅月日）：九月十七日 -> 用 doc_year 补
    if doc_year:
        m = re.search(r'([一二三四五六七八九十]{1,2})月([一二三四五六七八九十]{1,2})日', seg)
        if m:
            return doc_year + "-" + _cn_num(m.group(1)) + "-" + _cn_num(m.group(2))
    return None


def _find_all_dates(seg, doc_year=None):
    """返回片段中所有日期（去连续重复），用于交易期等需成对日期的场景。"""
    out = []
    pos = 0
    while pos < len(seg):
        d = _extract_first_date(seg[pos:], doc_year)
        if not d:
            break
        out.append(d)
        idx = seg[pos:].find(d)
        if idx < 0:
            break
        pos += idx + len(d)
    return out


def _find_rights_deadline(text, doc_year=None):
    """寻找供股权付款截止日期。精度优先（宁可空白也不写错）。
    优先级：
      1) 强模式：最後接納時限 后紧跟 指/即/為/是 + 日期（最可靠，如「最後接納時限」指 二零二五年十二月九日」）
      2) 次强：最後接納時限 本身，取其前后最近日期
      3) 兜底：繳付股款之截止時間 / 截止時間，仅取其后日期"""
    # 1) 强模式
    _strong = re.compile(r'最後接納時限[」]?\s*(?:指|即|為|是)\s*')
    for m in _strong.finditer(text):
        _d = _extract_first_date(text[m.end():m.end()+80], doc_year)
        if _d:
            return _d
    # 2) 次强：最後接納時限（前后最近日期）
    for m in re.finditer(r'最後接納時限', text):
        _d = _extract_first_date(text[m.end():m.end()+100], doc_year)
        if _d:
            return _d
        _pre = _find_all_dates(text[max(0, m.start()-100):m.start()], doc_year)
        if _pre:
            return _pre[-1]
    # 注：不采用「截止時間/最後時限」等宽泛兜底——港股公告中这些词前后常夹多个无关日期，
    # 易误抓（如把买卖截止/除权截止当作付款截止），宁可留空也不写错数据。
    return None


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
