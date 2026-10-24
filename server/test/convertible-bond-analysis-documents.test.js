const assert=require('assert');
const {spawnSync}=require('child_process');
const path=require('path');
const fs=require('fs');
const root=path.join(__dirname,'..','..');
const py=require('../services/arbitrageParser').resolvePython();
const code=String.raw`
import sys, os, tempfile, io, importlib
sys.path.insert(0, 'server/scripts')
import fitz
import convertibleBondDocument as reader
from document_pdf_cache import put_cached_pdf, pdf_cache_path
with tempfile.TemporaryDirectory() as directory:
    os.environ['DOCUMENT_PDF_CACHE_DIR'] = directory
    doc=fitz.open(); page=doc.new_page(); page.insert_text((40,40), '002091 TestBond')
    data=doc.tobytes(); url='https://disc.static.szse.cn/test.pdf'
    put_cached_pdf(url,data)
    def forbidden(*args,**kwargs): raise AssertionError('cache hit performed network request')
    reader.guarded_urlopen=forbidden
    pages,evidence=reader.read_document(url,'002091.SZ','TestBond')
    assert len(evidence['document_hash'])==64
    try: reader.read_document(url,'600000.SH','TestBond'); assert False
    except ValueError: pass
    for evil in ['http://disc.static.szse.cn/a.pdf','https://disc.static.szse.cn.evil.test/a.pdf']:
        try: reader.read_document(evil); assert False
        except ValueError: pass
    pdf_cache_path(url).write_bytes(b'broken')
    calls=[]
    def download(*args,**kwargs): calls.append(1); return io.BytesIO(data)
    reader.guarded_urlopen=download
    reader.read_document(url,'002091.SZ','TestBond')
    assert len(calls)==1
rating=importlib.import_module('extractConvertibleBondRating')
outlook_text='评级展望\n中诚信国际认为，瑞鹄汽车模具股份有限公司信用水平在未来12~18个月内将保持稳定。'
assert rating.parse_rating_pages([outlook_text], '瑞鹄转02', '2026-09-15', '瑞鹄汽车模具股份有限公司')['rating_outlook']=='稳定'
assert rating.parse_rating_pages([outlook_text], '其他转债', '2026-09-15', '其他股份有限公司')['rating_outlook'] is None
assert rating.parse_rating_pages(['前次'+outlook_text], '瑞鹄转02', '2026-09-15', '瑞鹄汽车模具股份有限公司')['rating_outlook'] is None
assert rating.parse_rating_pages([outlook_text+outlook_text.replace('稳定','负面')], '瑞鹄转02', '2026-09-15', '瑞鹄汽车模具股份有限公司')['rating_outlook'] is None
# BOND-RATING-RESULT-NOTICE-025: 直接代码身份、本次/前次日期和债项分离，不用主体或前次值补本次。
notice='''证券代码：603058 转债代码：113646 转债简称：永吉转债
贵州永吉印务股份有限公司关于“永吉转债”2024年跟踪评级结果的公告
前次债项评级：“AA-” 主体评级：“AA+” 评级展望：稳定
本次债项评级：“AA-” 主体评级：“AA+” 评级展望：稳定
根据规定，公司委托信用评级机构远东资信评估有限公司（以下简称“远东资信”）进行跟踪评级。公司前次主体信用评级结果为AA+；永吉转债前次评级结果为AA-；评级机构为远东资信，评级时间为2023年5月29日。
评级机构于2024年5月27日出具了《贵州永吉印务股份有限公司2024年跟踪评级报告》（远东跟踪（2024）0006号），本次公司主体信用评级结果为：AA+，评级展望：稳定；永吉转债评级结果为：AA-。'''
parse_notice=lambda text, code='113646.SH': rating.parse_rating_result_notice([text],'永吉转债',code,'贵州永吉印务股份有限公司','2024-05-29')
actual=parse_notice(notice)
# BOND-RATING-NOTICE-AGENCY-034：明确委托评级公司全称无需重复“评级机构”字样，审计/咨询公司不冒充评级机构。
direct_agency=parse_notice(notice.replace('委托信用评级机构远东资信评估有限公司','委托远东资信评估有限公司'))
assert direct_agency['rating_com_name']=='远东资信评估有限公司'
assert direct_agency['rating_result_notice']['rating_company']=='远东资信评估有限公司'
unrelated=parse_notice(notice.replace('委托信用评级机构远东资信评估有限公司','委托其他审计服务有限公司'))
assert unrelated['rating_com_name'] is None and not unrelated['rating_result_notice']['previous_ratings']
assert parse_notice(notice+'公司另委托大公国际资信评估有限公司。')['rating_com_name'] is None
assert (actual['rating'],actual['rating_date'],actual['rating_outlook'])==('AA-','2024-05-27','稳定')
assert actual['rating_com_name']=='远东资信评估有限公司'
assert actual['rating_result_notice']['report_reference']['number']=='远东跟踪(2024)0006号'
prior=actual['rating_result_notice']['previous_ratings'][0]
assert (prior['rating'],prior['rating_date'],prior['rating_outlook'])==('AA-','2023-05-29','稳定')
for code in ['113647.SH',None]:
    try: parse_notice(notice,code); assert False
    except ValueError: pass
assert parse_notice(notice.replace('永吉转债评级结果为：AA-','永吉转债评级结果为：A+'))['rating'] is None
assert parse_notice(notice.replace('本次债项评级：“AA-”','本次主体评级：“AA+”').replace('永吉转债评级结果为：AA-','其他转债评级结果为：AA-'))['rating'] is None
assert parse_notice(notice.replace('于2024年5月27日出具了','于2023年5月29日曾出具了'))['rating_date'] is None
assert parse_notice(notice.replace('前次评级结果为AA-','前次评级结果为AA'))['rating_result_notice']['previous_ratings']==[]
assert parse_notice(notice.replace('前次债项评级：“AA-”','前次债项评级：“AA+”'))['rating_result_notice']['previous_ratings']==[]
assert parse_notice(notice.replace('评级机构为远东资信','评级机构为另一机构'))['rating_result_notice']['previous_ratings']==[]
# BOND-RATING-NOTICE-LABEL-027: 贵燃2023官方原文，债券标签、本次提示段与主体/前次隔离。
gui_notice='''证券代码：600903 证券简称：贵州燃气 公告编号：2023-038
债券代码：110084 债券简称：贵燃转债
贵州燃气集团股份有限公司 关于“贵燃转债”跟踪信用评级结果的公告
重要内容提示：前次评级结果：主体评级“AAA”，评级展望“负面”；“贵燃转债”评级“AAA”。
本次评级结果：主体评级“AA+”，评级展望“稳定”；“贵燃转债”评级“AA”。
根据规定，公司委托信用评级机构中诚信国际信用评级有限责任公司（以下简称“中诚信国际”）进行跟踪评级。
中诚信国际于2023年6月14日出具了《贵州燃气集团股份有限公司2023年度跟踪评级报告》，本次评级结果较前次没有变化。'''
parse_gui=lambda text,code='110084.SH',issuer='贵州燃气集团股份有限公司': rating.parse_rating_result_notice([text],'贵燃转债',code,issuer,'2023-06-16')
gui=parse_gui(gui_notice)
assert (gui['rating'],gui['rating_outlook'],gui['rating_date'])==('AA','稳定','2023-06-14')
assert gui['rating_com_name']=='中诚信国际信用评级有限责任公司'
# BOND-RATING-NOTICE-CANDIDATES-028：简称在前、代码在后是独立表头字段，不能误当成更长债名。
reversed_header=gui_notice.replace('债券代码：110084 债券简称：贵燃转债','转债简称：贵燃转债 转债代码：110084')
assert parse_gui(reversed_header)['rating']=='AA'
try: parse_gui(reversed_header.replace('转债简称：贵燃转债','转债简称：贵燃转债2')); assert False
except ValueError: pass
for text,code,issuer in [(gui_notice,'110085.SH','贵州燃气集团股份有限公司'),(gui_notice,'110084.SH','其他股份有限公司'),(gui_notice.replace('债券简称：贵燃转债','债券简称：其他转债'),'110084.SH','贵州燃气集团股份有限公司'),(gui_notice.replace('债券代码：110084','债券代码：110084 转债代码：110085'),'110084.SH','贵州燃气集团股份有限公司')]:
    try: parse_gui(text,code,issuer); assert False
    except ValueError: pass
assert parse_gui(gui_notice.replace('“贵燃转债”评级“AA”','“其他转债”评级“AA”'))['rating'] is None
assert parse_gui(gui_notice.replace('本次评级结果：','本次债项评级：“A+”。本次评级结果：'))['rating'] is None
# BOND-RATING-NOTICE-NARRATIVE-043：闻泰2023原文的标题末尾年份、点名债项及同段展望。
wentai='''证券代码：600745 转债代码：110081 转债简称：闻泰转债
闻泰科技股份有限公司关于“闻泰转债”2023年跟踪评级结果的公告
前次债券评级：主体信用等级为“AAA”，评级展望为“负面”；债项信用等级为“AAA”。
本次债券评级：主体信用等级为“AA+”，评级展望为“稳定”；债项信用等级为“AA+”。
公司委托信用评级机构中诚信国际信用评级有限责任公司（以下简称“中诚信”）进行跟踪评级。
公司前次主体信用评级结果为“AAA”，评级展望为“负面”；“闻泰转债”前次债项信用评级结果为“AAA”，评级机构为中诚信，评级时间为2022年6月16日。
评级机构中诚信在对公司经营状况及相关行业进行综合分析与评估的基础上，于2023年6月19日出具了《闻泰科技股份有限公司公开发行可转换公司债券跟踪评级报告（2023）》（信评委函字[2023]跟踪0555号），评级结果如下：维持公司主体信用等级为“AA+”，评级展望为“稳定”，同时维持“闻泰转债”的债项信用等级为“AA+”。'''
parse_wentai=lambda text: rating.parse_rating_result_notice([text],'闻泰转债','110081.SH','闻泰科技股份有限公司','2023-06-20')
wentai_result=parse_wentai(wentai)
assert (wentai_result['rating'],wentai_result['rating_date'],wentai_result['rating_outlook'])==('AA+','2023-06-19','稳定')
assert wentai_result['rating_result_notice']['report_reference']['title'].endswith('评级报告(2023)')
assert parse_wentai(wentai.replace('“闻泰转债”的债项信用等级为','“其他转债”的债项信用等级为'))['rating'] is None
assert parse_wentai(wentai.replace('闻泰转债”的债项信用等级为','闻泰转债”前次债项信用等级为'))['rating'] is None
assert parse_wentai(wentai.replace('《闻泰科技股份有限公司','《其他股份有限公司'))['rating_date'] is None
assert parse_wentai(wentai.replace('评级展望为“稳定”，同时','评级展望为“负面”，同时'))['rating_outlook']=='负面'
assert parse_wentai(wentai.replace('出具了《','出具《'))['rating_date']=='2023-06-19'
assert parse_wentai(wentai.replace('的债项信用等级为','的信用等级为'))['rating']=='AA+'
assert parse_wentai(wentai.replace('评级展望为“稳定”，同时','评级展望为“稳定”，评级展望为“负面”，同时'))['rating_outlook'] is None
assert parse_wentai(wentai+'本次评级结果：闻泰转债评级AA。')['rating'] is None
rating.read_document=lambda *a: (['维持“国泰转债”信用等级为AA+，评级展望为稳定。本次评级时间 国泰转债 AA+/稳定 2026/06/23'],{'document_hash':'hash'})
result=rating.extract_rating('url','2026-06-25','002091.SZ','国泰转债')
assert result['rating']=='AA+' and result['rating_outlook']=='稳定' and result['rating_date']=='2026-06-23'
rating.read_document=lambda *a: (['本评级机构评定华海药业主体信用等级为AA，评级展望为稳定，华海转债信用等级均为AA。其他转债信用等级为AAA。'],{'document_hash':'hash'})
result=rating.extract_rating('url','2026-06-27','600521.SH','华海转债')
assert result['rating']=='AA' and result['rating_outlook']=='稳定' and result['rating_date_source']=='announcement_fallback'
assert rating.extract_rating('url','2026-06-27','600521.SH','不存在转债')['rating'] is None
# BOND-ANALYSIS-OCR-001: 债项等级不能借用主体等级，中文日期与OCR字段证据独立保存。
parsed=rating.parse_rating_pages(['华海转债 主体/展望/债项/评级时间 本次跟踪：AAA/稳定/AA/2023年6月27日 前次跟踪：AAA/稳定/AA/2022年6月24日'],'华海转债','2023-06-29')
assert parsed['rating']=='AA' and parsed['rating_date']=='2023-06-27'
parsed=rating.parse_rating_pages(['维持“洪城转债”信用等级为AA+，评级展望为稳定。二〇二六年六月八日'],'洪城转债','2026-06-13')
assert parsed['rating_date']=='2026-06-08' and parsed['rating_date_source']=='official_document'
# BOND-ANALYSIS-NATIVE-002: 有效原生维持结论与机构签署日期无需OCR。
parsed=rating.parse_rating_pages(['“精工转债”的信用等级维持AA，评级展望维持稳定。二〇二六年五月十五日'],'精工转债','2026-05-19')
assert parsed['rating']=='AA' and parsed['rating_outlook']=='稳定' and parsed['rating_date']=='2026-05-15'
parsed=rating.parse_rating_pages(['“闻泰转债”信用等级由AA调整至AA-，评级展望为稳定。中诚信国际信用评级有限责任公司\n2025年6月16日'],'闻泰转债','2025-06-18')
assert parsed['rating']=='AA-' and parsed['rating_date']=='2025-06-16'
assert rating.official_rating_date(['历史2025年6月16日，其他无关事项2025年6月17日'])[0] is None
# BOND-RATING-TABLE-007: 当前债项表不借用主体等级，第四页明确日期可核验。
parsed=rating.parse_rating_pages(['封面','声明','主体资料','评级结果\n本次评级\n上次评级\n主体信用等级\nAAA\nAAA\n评级展望\n稳定\n稳定\n蓝天转债\nAA\nAA\n评级日期2026年6月15日'],'蓝天转债','2026-06-17')
assert parsed['rating']=='AA' and parsed['rating_date']=='2026-06-15'
assert rating.official_rating_date(['评级时间2026.5.18','附录\n评级日期2025.5.18'])[0]=='2026-05-18'
# BOND-RATING-LEGACY-012: 公开发行旧格式、债券期限及真实日期优先，不能借主体等级。
legacy=['神马实业股份有限公司公开发行可转换公司债券信用等级通知书\n主体信用等级为AA+，评级展望为稳定。\n本期公开发行可转换公司债券的信用等级为AAA。二〇二二年八月六日',
        '神马实业股份有限公司公开发行可转换公司债券信用评级报告',
        '发行规模：不超过30.00亿元\n债券期限：6年\n评级时间2022年08月05日']
rating.read_document=lambda *a,**kwargs:(legacy,{'document_hash':'a'*64})
parsed=rating.extract_rating('url','2023-03-14','600810.SH','神马转债','神马实业股份有限公司','2023-03-16','3000000000',6)
assert parsed['rating']=='AAA' and parsed['rating_outlook']=='稳定' and parsed['rating_date']=='2022-08-05'
assert parsed['identity_binding']['document_title']=='公开发行可转换公司债券信用等级通知书'
assert parsed['identity_binding']['validated'] is False
blue=['河南蓝天燃气股份有限公司2022年公开发行可转换公司债券信用评级报告','声明',
      '本期债券的信用等级为AA。中证鹏元给予公司稳定的信用评级展望。\n发行规模8.7亿元\n发行期限6年\n评级自期证券评级评审专用章2022-09-30']
rating.read_document=lambda *a,**kwargs:(blue,{'document_hash':'a'*64})
parsed=rating.extract_rating('url','2023-08-11','605368.SH','蓝天转债','河南蓝天燃气股份有限公司','2023-08-15','870000000',6)
assert parsed['rating']=='AA' and parsed['rating_outlook']=='稳定' and parsed['rating_date']=='2022-09-30'
# BOND-RATING-COLUMN-013: 明确本次列优先于历史正文，反转表头仍取本次而非首个数值。
for headers,values in [('本次评级\n上次评级','AA\nAAA'),('上次评级\n本次评级','AAA\nAA')]:
    parsed=rating.parse_rating_pages(['评级结果\n'+headers+'\n蓝天转债\n'+values+'\n评级日期2026年6月15日','历史蓝天转债信用等级为AAA。'],'蓝天转债','2026-06-17')
    assert parsed['rating']=='AA'
# BOND-RATING-INITIAL-008: 未命名首发评级只按统一身份中的唯一发行金额/期限绑定。
# BOND-RATING-NARRATIVE-018: 前次/本次叙述隔离，带引号展望与出具报告实际日期不借旧日期。
narrative='前次债券评级：公司主体信用等级为“A+”，评级展望为“负面”，“国力转债”的信用等级为“A+”。\n本次债券评级：主体信用等级为“AAA”，评级展望为“稳定”，“国力转债”的信用等级为“AA”。\n公司前次评级结果为A+，评级时间为2025年6月24日。\n中证鹏元于2026年6月23日出具了《公司相关债券2026年跟踪评级报告》，本次评级展望维持“稳定”。'
parsed=rating.parse_rating_pages([narrative],'国力转债','2026-06-25')
assert parsed['rating']=='AA' and parsed['rating_outlook']=='稳定' and parsed['rating_date']=='2026-06-23'
assert '2026年6月23日' in parsed['date_evidence']
parts=narrative.split('于2026',1)
parsed=rating.parse_rating_pages([parts[0]+'于','2026'+parts[1]],'国力转债','2026-06-25')
assert parsed['rating_date']=='2026-06-23','跨页出具日期不能丢句首或借前次日期'
parsed=rating.parse_rating_pages(['公司前次评级时间为2025年6月24日。本次“国力转债”信用等级为“AA”，评级展望为“稳定”。'],'国力转债','2026-06-25')
assert parsed['rating_date_source']=='announcement_fallback'
# BOND-RATING-CURRENT-ROW-022: 评级时间表头下只取明确本次行，混排不按两个日期大小猜列。
# BOND-RATING-ISSUE-PUBLICATION-024: 万元千分位/换行本期公司债券、明确首发封面日及实际上市前发布。
from decimal import Decimal
for amount in ['1,200,000.00万元','1,200.000.00万元','120亿元','12000000000元']:
    assert rating.initial_issue_amount('发行规模拟发行总额不超过人民币'+amount)[0]==Decimal('12000000000')
for bad in ['1,20,000.00万元','1,200.00.00万元','120.0.0亿元']:
    assert rating.initial_issue_amount('发行规模'+bad)==(None,None)
cover='通威股份有限公司\n公开发行A股可转换公司债券信用评级报告\n2021年6月4日'
assert rating.initial_report_cover_date([cover],'通威股份有限公司')[0]=='2021-06-04'
assert rating.initial_report_cover_date([cover.replace('2021年6月4日','2021 年6 月4 日')],'通威股份有限公司')[0]=='2021-06-04'
for invalid in [cover+'\n2021年6月5日',cover.replace('信用评级报告','跟踪信用评级报告'),cover.replace('通威股份有限公司','其他公司')]:
    assert rating.initial_report_cover_date([invalid],'通威股份有限公司')==(None,None)
tong=[cover,'主体信用等级为AAA，评级展望为稳定，本期公司债券的信用\n等级为AA+。',
    '发行规模\n拟发行总额不超过人民币1,200.000.00万元\n债券期限\n自发行之日起6年']
rating.read_document=lambda *a,**kwargs:(tong,{'document_hash':'a'*64})
for announced in ['2022-02-22','2022-03-11','2022-03-18']:
    result=rating.extract_rating('url',announced,'600438.SH','通22转债','通威股份有限公司','2022-02-24','12000000000',6,'2022-03-18')
    assert result['rating']=='AA+' and result['rating_date']=='2021-06-04' and result['rating_date_context']=='initial_report_cover'
    assert result['identity_binding']['validated'] is False and '万元' in result['identity_binding']['issue_amount_evidence']
for announced,listed,size in [('2022-03-19','2022-03-18','12000000000'),('2022-03-11',None,'12000000000'),('2022-02-22','2022-03-18','145868000')]:
    result=rating.extract_rating('url',announced,'600438.SH','通22转债','通威股份有限公司','2022-02-24',size,6,listed)
    assert result['rating'] is None and 'identity_binding' not in result
bo=['江苏苏博特新材料股份有限公司2021年公开发行可转换公司债券信用评级报告\n2021 年11 月10 日',
    '主体信用等级AAA，评级展望为稳定，本期公司债券的信用等级为AA-。',
    '本次发行的可转换公司债券规模为不超过8亿元（含8亿元），期限为6年，采用每年付息一次。']
rating.read_document=lambda *a,**kwargs:(bo,{'document_hash':'a'*64})
result=rating.extract_rating('url','2022-07-07','603916.SH','博22转债','江苏苏博特新材料股份有限公司','2022-07-01','800000000',6,'2022-07-28')
assert result['rating']=='AA-' and result['rating_date']=='2021-11-10' and result['identity_binding']['validated'] is False
bo[2]='本次发行的可转换公司债券规模为不超过8亿元，其他银行贷款期限为6年。'
assert rating.extract_rating('url','2022-07-07','603916.SH','博22转债','江苏苏博特新材料股份有限公司','2022-07-01','800000000',6,'2022-07-28')['rating'] is None
# BOND-RATING-GRADE-CONFLICT-023: 等级符号不得截断，当前正式结论/债项表冲突不可发布。
# BOND-RATING-EXACT-ISSUE-033：本次债券精确条款优先摘要舍入值，不对金额近似匹配。
guotai=['江苏国泰国际集团股份有限公司公开发行可转换公司债券信用评级报告',
    '发行规模：不超过45.57亿元（含）\n债券期限：6年\n评级时间：2020年11月13日\n本期债券的信用等级为AA+，评级展望为稳定。',
    '二、本次可转换公司债券概况及募集资金用途\n本次可转换公司债券发行规模为不超过人民币455.741.86万元（含），按面值发行。']
rating.read_document=lambda *a,**kwargs:(guotai,{'document_hash':'a'*64})
guotai_args=('url','2021-07-03','002091.SZ','国泰转债','江苏国泰国际集团股份有限公司','2021-07-07','4557418600',6,'2021-08-10')
parsed=rating.extract_rating(*guotai_args)
assert parsed['rating']=='AA+' and parsed['rating_date']=='2020-11-13'
assert '455.741.86万元' in parsed['identity_binding']['issue_amount_evidence']
precise_clause=guotai[2]
guotai[2]=''
assert rating.extract_rating(*guotai_args)['rating'] is None,'仅摘要舍入值不能近似匹配'
guotai[2]=precise_clause.replace('455.741.86','455.741.85')
assert rating.extract_rating(*guotai_args)['rating'] is None,'精确金额相差100元也拒绝'
guotai[2]=precise_clause+'本次可转换公司债券发行规模不超过40亿元。'
assert rating.initial_issue_amount(guotai[2])==(None,None),'两份本次正式条款冲突拒绝'
# BOND-RATING-ISSUE-TABLE-031：明确发行要素列及中文期限，不借其他贷款金额或期限。
# BOND-RATING-ISSUE-TENOR-039：明确发行要素表的唯一裸年限仍与本债期限精确匹配，矛盾年限拒绝。
horizontal=['新疆天业股份有限公司公开发行可转换公司债券信用评级报告\n2021年7月27日',
    '本期可转换公司债券的信用等级为AA+，评级展望为稳定。',
    '发行要素\n发行主体\n本期规模\n发行期限\n转股期限\n偿还方式\n新疆天业股份有限公司\n不超过30亿元\n6年\n发行结束之日起满六个月\n支付最后一年利息\n评级观点：业务稳定。']
rating.read_document=lambda *a,**kwargs:(horizontal,{'document_hash':'a'*64})
horizontal_args=('url','2022-06-21','600075.SH','天业转债','新疆天业股份有限公司','2022-06-23','3000000000',6,'2022-07-19')
assert rating.extract_rating(*horizontal_args)['rating']=='AA+'
for bad in [horizontal[2].replace('6年','5年'),horizontal[2].replace('评级观点','其他贷款3年。评级观点'),horizontal[2].replace('发行期限','项目年限')]:
    original=horizontal[2];horizontal[2]=bad
    assert rating.extract_rating(*horizontal_args)['rating'] is None
    horizontal[2]=original
summary='发行要素\n发行主体\n本期规模\n发行期限\n偿还方式\n贵州燃气集团股份有限公司\n不超过10亿元（含10亿元）\n自发行之日起六年\n按年付息\n评级观点：公司业务稳定。'
guiran=['贵州燃气集团股份有限公司公开发行可转换公司债券信用评级报告\n2021年6月23日',
    '本期债券的信用等级为AA，评级展望为稳定。', summary]
rating.read_document=lambda *a,**kwargs:(guiran,{'document_hash':'a'*64})
parsed=rating.extract_rating('url','2021-12-23','600903.SH','贵燃转债','贵州燃气集团股份有限公司','2021-12-27','1000000000',6,'2022-01-18')
assert parsed['rating']=='AA' and parsed['rating_date']=='2021-06-23' and parsed['identity_binding']['validated'] is False
for bad in [summary.replace('本期规模','银行贷款'),summary.replace('六年','五年'),summary.replace('10亿元','11亿元')]:
    guiran[2]=bad
    assert rating.extract_rating('url','2021-12-23','600903.SH','贵燃转债','贵州燃气集团股份有限公司','2021-12-27','1000000000',6,'2022-01-18')['rating'] is None
# BOND-RATING-ISSUE-TABLE-031：发债规模是明确债项字段，保留原始引文及精确发行匹配。
jinggong=['长江精工钢结构（集团）股份有限公司公开发行可转换公司债券信用评级报告',
    '长江精工钢结构（集团）股份有限公司公开发行可转换公司债券的信用等级为AA，评级展望为稳定。二〇二一年八月二十六日',
    '债项概况\n发债规模不超过20亿元（含20亿元）\n债券期限：6年']
rating.read_document=lambda *a,**kwargs:(jinggong,{'document_hash':'a'*64})
parsed=rating.extract_rating('url','2022-04-20','600496.SH','精工转债','长江精工钢结构(集团)股份有限公司','2022-04-22','2000000000',6,'2022-05-23')
assert parsed['rating']=='AA' and parsed['rating_date']=='2021-08-26'
assert parsed['identity_binding']['issue_amount_evidence']=='发债规模不超过20亿元'
jinggong[2]=jinggong[2].replace('20亿元','21亿元')
assert rating.extract_rating('url','2022-04-20','600496.SH','精工转债','长江精工钢结构(集团)股份有限公司','2022-04-22','2000000000',6,'2022-05-23')['rating'] is None
for minus in ['−','–','‐','‑','－']:
    parsed=rating.parse_rating_pages(['本次“测试转债”的信用等级为AA'+minus+'，评级展望稳定。评级日期2026年6月15日'],'测试转债','2026-06-17')
    assert parsed['rating']=='AA-' and not parsed['rating_conflicts']
conflict_pages=['本次维持“永吉转债”的信用等级为AA，评级展望稳定。',
    '评级结果\n上次评级\n本次评级\n永吉转债\n1.46\n6\nAA-\nAA-\n评级日期2023年5月29日']
parsed=rating.parse_rating_pages(conflict_pages,'永吉转债','2023-05-31')
assert parsed['rating'] is None and {v['rating'] for v in parsed['rating_conflicts']}=={'AA','AA-'}
parsed=rating.parse_rating_pages(['本次“测试转债”信用等级为AA。此次“测试转债”信用等级为AAA。评级展望稳定。'],'测试转债','2026-06-17')
assert parsed['rating'] is None and len(parsed['rating_conflicts'])==3
parsed=rating.parse_rating_pages(['前次“测试转债”信用等级为AAA。本次“测试转债”信用等级为AA-。评级展望稳定。历史评级“测试转债”信用等级为AAA。'],'测试转债','2026-06-17')
assert parsed['rating']=='AA-' and not parsed['rating_conflicts']
parsed=rating.parse_rating_pages(['本次“测试转债”信用等级为AA。主体信用等级AAA。其他转债信用等级AAA。评级模型级别AA-。'],'测试转债','2026-06-17')
assert parsed['rating']=='AA' and not parsed['rating_conflicts']
rating.read_document=lambda *a,**kwargs:(conflict_pages,{'document_hash':'a'*64})
assert rating.extract_rating('url','2023-05-31','603058.SH','永吉转债')['rating'] is None
for old,current in [('2021.03.15','2022.06.28'),('2022.06.28','2023.05.29')]:
    rows='评级结果\n主体信用等级\n评级展望\n评级时间\n上次评级\n'+old+'\n本次评级\n资\n'+current+'\n债项简称\n永吉转债\n维持“永吉转债”的信用等级为AA，评级展望稳定。'
    parsed=rating.parse_rating_pages([rows],'永吉转债','2024-06-30')
    assert parsed['rating_date']==current.replace('.','-') and parsed['rating_date_context']=='current_summary_table'
    assert '本次评级' in parsed['date_evidence']
assert rating.current_summary_date(['评级结果 评级时间 上次评级 2023.05.29 2024.05.27 本次 债券简称'])==(None,None)
assert rating.current_summary_date(['评级结果 评级时间 上次评级2023.05.29 本次评级2024.05.27 主要财务数据 本次评级2025.05.27'])[0]=='2024-05-27'
assert rating.current_summary_date(['评级结果 评级时间 上次评级2023.05.29 本次评级2024.05.27 本次评级2024.05.28'])==(None,None)
assert rating.current_summary_date(['历史评级 评级结果 评级时间 上次评级2023.05.29 本次评级2024.05.27'])==(None,None)
# BOND-RATING-SINGLE-COLUMN-020: 本次单列债券表按明确目标行取级别，不借主体/模型或另一债。
single='本次评级结果\n评级时间：2026.6.18\n债券简称\n债券信用等级\n发行人主体信用等级\nAAA\n永吉转债\nAA-\n评级观点\n评级展望为稳定。评级模型级别AA。'
parsed=rating.parse_rating_pages([single],'永吉转债','2026-06-23')
assert parsed['rating']=='AA-' and parsed['rating_date']=='2026-06-18' and parsed['rating_outlook']=='稳定'
for invalid in [single.replace('永吉转债','其他转债'),single.replace('本次评级结果','历史评级信息'),single.replace('永吉转债\nAA-','永吉转债')]:
    assert rating.parse_rating_pages([invalid],'永吉转债','2026-06-23')['rating'] is None
for issuer,size,day in [('上海银行股份有限公司','20000000000','2020-08-28'),('兴业银行股份有限公司','50000000000','2021-09-01')]:
    bank=[issuer+'公开发行A股可转换公司债券信用评级报告','声明',
          '主体信用等级AAA\n债项信用等级AAA\n评级展望稳定\n评级时间'+day+'\n发行规模：不超过人民币'+str(int(size)//100000000)+'亿元\n存续期限自发行之日起6年']
    rating.read_document=lambda *a,**kwargs:(bank,{'document_hash':'a'*64})
    parsed=rating.extract_rating('url','2021-12-23','601166.SH','测试转债',issuer,'2021-12-27',size,6)
    assert parsed['rating']=='AAA' and parsed['rating_date']==day and parsed['identity_binding']['validated'] is False
# BOND-RATING-SHORTNAME-014: 同页唯一简称绑定本次/首次表，列顺序同时约束等级、日期和展望。
for headers,grades,dates,outlooks in [('本次\n首次','AA\nAAA','2021-6-15 2020-5-22','稳定\n负面'),('首次\n本次','AAA\nAA','2020-5-22 2021-6-15','负面\n稳定')]:
    page='评级结果\n'+headers+'\n主体信用等级AAA AAA\n评级展望\n'+outlooks+'\n债券信用等级\n'+grades+'\n评级日期 '+dates+'\n债券概况\n债券简称：大参转债'
    parsed=rating.parse_rating_pages([page],'大参转债','2021-06-17')
    assert parsed['rating']=='AA' and parsed['rating_date']=='2021-06-15' and parsed['rating_outlook']=='稳定'
    for other in [page.replace('债券简称：大参转债','债券简称：其他转债'),page+'\n债券简称：其他转债']:
        assert rating.parse_rating_pages([other],'大参转债','2021-06-17')['rating'] is None
initial=['无锡派克新材料科技股份有限公司2026年向不特定对象发行可转换公司债券信用评级报告','声明','评级结果\n主体信用等级\nAAA\n债券信用等级\nAA\n评级展望\n稳定\n评级日期2026-04-02\n发行规模：不超过15.8亿元\n发行期限：不超过6年']
rating.read_document=lambda *a,**kwargs:(initial,{'document_hash':'a'*64})
parsed=rating.extract_rating('url','2026-08-04','605123.SH','派克转债','无锡派克新材料科技股份有限公司','2026-08-06','1580000000',6)
assert parsed['rating']=='AA' and parsed['rating_date']=='2026-04-02' and parsed['identity_binding']['method']=='issuer_issue_amount_tenor_pending_identity'
for size,tenor,issuer in [('1580000001',6,'无锡派克新材料科技股份有限公司'),('1580000000',5,'无锡派克新材料科技股份有限公司'),('1580000000',6,'其他股份有限公司')]:
    assert rating.extract_rating('url','2026-08-04','605123.SH','派克转债',issuer,'2026-08-06',size,tenor)['rating'] is None
assert rating.extract_rating('url','2026-08-04','605123.SH','派克转债','无锡派克新材料科技股份有限公司')['rating'] is None
# BOND-RATING-CONCLUSION-016: 正式通知书债项结论优先摘要OCR孤立字形，冲突正式结论仍拒绝。
initial=['大参林医药集团股份有限公司\n信用等级通知书\n本期债券的信用等级为AA。评级展望为稳定。',
  '大参林医药集团股份有限公司2020年公开发行可转换公司债券信用评级报告','声明',
  '本期债券信用等级：A\n发行规模不超过14.05亿元\n债券期限6年\n评级日期2020年05月22日']
rating.read_document=lambda *a,**kwargs:(initial,{'document_hash':'a'*64})
parsed=rating.extract_rating('url','2020-10-20','603233.SH','大参转债','大参林医药集团股份有限公司','2020-10-22','1405000000',6)
assert parsed['rating']=='AA' and parsed['rating_date']=='2020-05-22' and any(':A' in e for e in parsed['secondary_rating_evidence'])
initial[0]+='本期债券的信用等级为AAA。'
assert rating.extract_rating('url','2020-10-20','603233.SH','大参转债','大参林医药集团股份有限公司','2020-10-22','1405000000',6)['rating'] is None
history=importlib.import_module('extractConvertibleBondPriceHistory')
history.read_document=lambda *a: (['无转股价调整表'],{'document_hash':'a'*64,'source_url':'url'})
assert history.extract_history('url')['document_hash']=='a'*64
import types
ocr_calls=[]
class FakeOCR:
    def __init__(self,**kwargs): assert kwargs=={'intra_op_num_threads':1,'inter_op_num_threads':1}
    def __call__(self,image):
        ocr_calls.append(1)
        return [[None,'002091 TestBond',0.99],[None,'错误低置信度',0.5]],None
sys.modules['rapidocr_onnxruntime']=types.SimpleNamespace(RapidOCR=FakeOCR)
with tempfile.TemporaryDirectory() as directory:
    os.environ['DOCUMENT_PDF_CACHE_DIR']=directory
    document=fitz.open();document.new_page();document.new_page();put_cached_pdf(url,document.tobytes())
    reader.guarded_urlopen=forbidden
    pages,evidence=reader.read_document(url,'002091.SZ','TestBond',ocr=True,stop_when=lambda pages: True)
    assert evidence['ocr_pages']==[1] and evidence['text_method']=='rapidocr-onnx-v1'
    assert '错误低置信度' not in ''.join(pages) and len(ocr_calls)==1
    # BOND-OCR-CHECKPOINT-032：中断后复用已完成页，仍按原顺序核验；PDF变化必须失效。
    class InterruptedOCR(FakeOCR):
        def __call__(self,image): raise RuntimeError('simulated interruption')
    sys.modules['rapidocr_onnxruntime'].RapidOCR=InterruptedOCR
    try: reader.read_document(url,'002091.SZ','TestBond',ocr=True); assert False
    except RuntimeError: pass
    assert len(ocr_calls)==1
    sys.modules['rapidocr_onnxruntime'].RapidOCR=FakeOCR
    pages,evidence=reader.read_document(url,'002091.SZ','TestBond',ocr=True)
    assert evidence['ocr_pages']==[1,2] and len(ocr_calls)==2
    sys.modules['rapidocr_onnxruntime'].RapidOCR=InterruptedOCR
    assert reader.read_document(url,'002091.SZ','TestBond',ocr=True)[0]==pages
    original_version=reader.version
    reader.version=lambda name: 'changed-test-version'
    try: reader.read_document(url,'002091.SZ','TestBond',ocr=True); assert False
    except RuntimeError: pass
    finally: reader.version=original_version
    document.new_page(); put_cached_pdf(url,document.tobytes())
    try: reader.read_document(url,'002091.SZ','TestBond',ocr=True); assert False
    except RuntimeError: pass
    sys.modules['rapidocr_onnxruntime'].RapidOCR=FakeOCR
holders=importlib.import_module('extractConvertibleBondFundHoldings')
unranked='前十名转债持有人情况如下：\n期末持债数量（元）\n持有比例(%)\n'+''.join(f'某证券投资基金{i}\n100000\n1.00\n' for i in range(10))+'(三)报告期转债变动情况\n'
parsed=holders.parse_holders(unranked)
assert len(parsed)==10 and holders.aggregate(parsed)['holding_quantity']==1
short_header=holders.parse_holders(unranked.replace('期末持债数量','期末持债数'))
assert len(short_header)==10 and short_header[0]['quantity']==1000 and short_header[0]['amount']==100000
assert holders.parse_holders(unranked.replace('期末持债数量（元）','期末持债数（张）'))==[]
joined_numbers='前十名转债持有人情况如下：\n序号\n报告期末持有可转债数量（张）\n报告期末持有可转债金额（元）\n'+''.join(f'{i}\n某基金{i}\n其他\n1,833,202 183,320,200.00\n9.17%\n' for i in range(1,11))
joined_holders=holders.parse_holders(joined_numbers)
assert len(joined_holders)==10 and joined_holders[0]['quantity']==1833202 and joined_holders[0]['amount']==183320200
assert sum(r['amount'] for r in parsed)==1000000 and sum(r['quantity'] for r in parsed)==10000
# BOND-ANALYSIS-WRAPPED-003: 元金额跨行只按完整千分位组拼接，比例独立。
wrapped=unranked.replace('期末持债数量','期末持债数\n量').replace('持有比例','持有比\n例').replace('100000','3,130,210,00\n0')
parsed=holders.parse_holders(wrapped)
assert len(parsed)==10 and parsed[0]['amount']==3130210000 and parsed[0]['ratio']==0.01
# BOND-HOLDERS-LABEL-009: 可转换公司债/拆行比例表头消费元金额，不消费前十股东。
bank=unranked.replace('前十名转债持有人情况如下：','前十名可转换公司债持有人情况').replace('期末持债数量','期末持有数量').replace('持有比例(%)','持有\n比例')
assert len(holders.parse_holders(bank))==10
assert len(holders.parse_holders(unranked.replace('持有比例(%)','比例(%)').replace('(三)报告期转债变动情况','7.3 可转债变动情况')))==10
assert len(holders.parse_holders(bank.replace('前十名可转换公司债持有人情况','前十名股东持股情况')))==0
single_bond=unranked.replace('100000','100')
assert len(holders.parse_holders(single_bond))==10 and sum(r['quantity'] for r in holders.parse_holders(single_bond))==10
holders.read_document=lambda *a: (['前十名转债持有人情况如下：\n只有一行'],{'document_hash':'hash'})
try: holders.extract('url'); assert False
except ValueError: pass
holders.read_document=lambda *a: (['未披露持有人表'],{'document_hash':'hash'})
assert holders.extract('url')['parse_status']=='not_disclosed'
# BOND-HOLDERS-NOT-LISTED-029：报告期内未上市须原文明示及目标债名绑定，不当成零基金。
unlisted='''公司发行的可转换公司债券于2026年7月16日在上海证券交易所上市交易，债券简称为“宝钛转债”，债券代码为“110101”。
（二）报告期转债持有人及担保人情况
不适用
注：报告期内公司可转换公司债券未上市。
（三）报告期转债变动情况
不适用'''
holders.read_document=lambda *a: ([unlisted],{'document_hash':'a'*64})
not_listed=holders.extract('url',bond_name='宝钛转债')
assert not_listed['parse_status']=='not_applicable'
assert not_listed['holder_exemption']['listing_date']=='2026-07-16'
assert 'fund_count' not in not_listed and 'holding_quantity' not in not_listed
assert holders.unlisted_holder_exemption(unlisted,'其他转债') is None
assert holders.unlisted_holder_exemption(unlisted.replace('报告期内公司可转换公司债券未上市。','暂无数据。'),'宝钛转债') is None
assert holders.unlisted_holder_exemption(unlisted.replace('不适用','适用'),'宝钛转债') is None
# BOND-ANALYSIS-SCOPE-001: 同一页/跨页两债只按明确债券名称表头归属，不拼接持有人。
one=unranked.replace('前十名转债持有人情况如下：','可转换公司债券名称\n甲转债\n前十名转债持有人情况如下：')
two=unranked.replace('前十名转债持有人情况如下：','可转换公司债券名称\n乙转债\n前十名转债持有人情况如下：').replace('100000','200000')
holders.read_document=lambda *a: ([one,two],{'document_hash':'hash'})
assert holders.extract('url',bond_name='甲转债')['holding_quantity']==1
assert holders.extract('url',bond_name='乙转债')['holding_quantity']==2
try: holders.extract('url',bond_name='丙转债'); assert False
except ValueError: pass
prospectus=importlib.import_module('extractConvertibleBondProspectus')
purpose_table='序号\n项目名称\n总投资额（万元）\n拟投入募集资金\n金额（万元）\n1\n特种无机膜组件及装置生产线项目\n23,712.65\n21,000.00\n2\n补充流动资金\n9,000.00\n9,000.00\n合计\n32,712.65\n30,000.00'
for title in ['本次募集资金的运用','本次募集资金使用计划','本次募集资金使用概况']:
    assert prospectus.fundraising_purpose([title+'\n'+purpose_table])=='1.特种无机膜组件及装置生产线项目\n2.补充流动资金'
assert prospectus.fundraising_purpose(['前次募集资金使用计划\n'+purpose_table]) is None
assert prospectus.fundraising_purpose(['公司决定变更前次募集资金用途，说明本次募集资金用途的调整。\n'+purpose_table]) is None
assert prospectus.fundraising_purpose(['本次募集资金的运用”之“二、本次募投项目的具体情况”。\n三、会计师对于公司前次募集资金使用情况的意见\n四、超过五年的前次募集资金用途变更的情形']) is None
assert prospectus.fundraising_purpose(['第七节 本次募集资金的运用\n一、本次募集资金使用计划\n'+purpose_table+'\n注：\n1\n不属于募投项目的审批说明\n100.00\n100.00'])=='1.特种无机膜组件及装置生产线项目\n2.补充流动资金'
# BOND-PROSPECTUS-CAPITAL-030：银行资本用途按完整原句，不要求虚构项目表。
capital='本行本次发行可转债募集的资金，扣除发行费用后将全部用于支持本行未来各项业务健康发展，在可转债转股后按照相关监管要求用于补充本行核心一级资本。'
assert prospectus.fundraising_purpose(['16、本次募集资金用途\n'+capital+'\n17、担保事项\n未提供担保。'])==capital
assert prospectus.fundraising_purpose(['16、本次募集资金用途\n具体用途尚未确定。\n17、担保事项\n未提供担保。']) is None
assert len(prospectus.coupon_rates('第一年：0.2％，第二年利率为0.4%，第三年0.6%，第四年1.0%，第五年1.5%，第六年2.0%'))==6
# BOND-COUPON-HEADING-010: 明确章节利率表不因缺少票面/债券前缀而跳过。
prospectus.read_document=lambda *a: (['（三）利率\n第一年0.30%、第二年0.50%、第三年1.00%、第四年1.50%、第五年1.80%、第六年2.00%'],{'document_hash':'a'*64})
assert len(prospectus.extract('url')['coupon_rates'])==6
# BOND-RATING-ADJUST-NOTICE-050：调整前/调整后型公告取调整后结论，日期取出具公告实际日而非前次评级时间。
adjust='''证券代码：600745 证券简称：*ST闻泰 转债代码：110081 转债简称：闻泰转债
闻泰科技股份有限公司关于“闻泰转债”不定期跟踪评级结果的公告
重要内容提示：
调整前闻泰转债评级：主体信用等级为“BBB+”，评级展望为“稳定”；债项信用等级为“BBB+”。
调整后闻泰转债评级：主体信用等级为“BBB-”，评级展望为“负面”；债项信用等级为“BBB-”。
公司前次主体信用评级结果为“BBB+”，评级展望为“稳定”；“闻泰转债”前次债项信用评级结果为“BBB+”，评级机构为中诚信，评级时间为2026年5月26日。
评级机构中诚信于2026年9月15日出具了《中诚信国际关于调降闻泰科技股份有限公司主体及相关债项信用等级的公告》，评级结果如下：调整公司主体信用等级为“BBB-”，评级展望为负面；同时调整“闻泰转债”信用等级至“BBB-”。'''
adjust_result=rating.parse_rating_result_notice([adjust],'闻泰转债','110081.SH','闻泰科技股份有限公司','2026-09-17','600745.SH')
assert (adjust_result['rating'],adjust_result['rating_outlook'],adjust_result['rating_date'])==('BBB-','负面','2026-09-15'),adjust_result
# BOND-RATING-NOTICE-STOCK-CODE-051：只写证券代码不写转债代码的正式公告，按 简称+证券代码+发行人 绑定。
no_code='''证券代码：603759 证券简称：海天股份 公告编号：2026-055
海天水务集团股份公司关于“海天转债”2026年跟踪评级结果的公告
前次评级结果：公司主体信用等级为“AA”；评级展望为“稳定”；“海天转债”信用等级为“AA”
本次评级结果：公司主体信用等级为“AA”；评级展望为“稳定”；“海天转债”信用等级为“AA”'''
assert rating.parse_rating_result_notice([no_code],'海天转债','113700.SH','海天水务集团股份公司','2026-06-01','603759.SH')['rating']=='AA'
for issuer,stock in [('其他股份有限公司','603759.SH'),('海天水务集团股份公司',None),('海天水务集团股份公司','600000.SH')]:
    try: rating.parse_rating_result_notice([no_code],'海天转债','113700.SH',issuer,'2026-06-01',stock); assert False
    except ValueError: pass
# BOND-RATING-NAME-HEADER-052：债名后接公司名不是更长债名；数字扩展仍拒绝。
own='''证券代码：603477 证券简称：巨星农牧 债券代码：113648 债券简称：巨星转债
乐山巨星农牧股份有限公司关于收到可转债评级机构跟踪评级结果的公告
前次评级结果：主体信用等级为“AA-”，评级展望为“稳定”；“巨星转债”信用等级为“AA-”
本次评级结果：主体信用等级为“AA-”，评级展望为“稳定”；“巨星转债”信用等级为“AA-”'''
assert rating.parse_rating_result_notice([own],'巨星转债','113648.SH','乐山巨星农牧股份有限公司','2026-07-25','603477.SH')['rating']=='AA-'
try: rating.parse_rating_result_notice([own.replace('债券简称：巨星转债','债券简称：巨星转债2\n债券代码：113648')],'巨星转债','113648.SH','乐山巨星农牧股份有限公司','2026-07-25','603477.SH'); assert False
except ValueError: pass
# BOND-RATING-OBSERVE-ROW-053：首次评级表头与观察名单状态词不妨碍取本债行。
observe='评级结果\n评级日期2026年06月25日\n本次评级\n首次评级\n主体信用等级\nA+\nA+\n评级展望\n--\n稳定\n侨银转债\nA+\n列入观察名单\nA+'
parsed=rating.parse_rating_pages([observe],'侨银转债','2026-06-27')
assert parsed['rating']=='A+' and parsed['rating_date_source']=='official_document'
assert rating.issuer_forms('海天水务集团股份公司')=={'海天水务集团股份公司','海天水务'}
print('BOND-ANALYSIS-004: official identity, PDF cache, corruption, complete holder table and rating date passed')
`;
if(path.isAbsolute(py))assert.ok(fs.existsSync(py),'venv python 不存在: '+py);
const result=spawnSync(py,['-c',code],{cwd:root,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:30000});
assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
