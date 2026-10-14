const assert=require('assert');
const {spawnSync}=require('child_process');
const path=require('path');
const fs=require('fs');
const root=path.join(__dirname,'..','..');
const py=process.platform==='win32'?path.join(root,'venv','Scripts','python.exe'):path.join(root,'venv','bin','python');
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
holders=importlib.import_module('extractConvertibleBondFundHoldings')
unranked='前十名转债持有人情况如下：\n期末持债数量（元）\n持有比例(%)\n'+''.join(f'某证券投资基金{i}\n100000\n1.00\n' for i in range(10))+'(三)报告期转债变动情况\n'
parsed=holders.parse_holders(unranked)
assert len(parsed)==10 and holders.aggregate(parsed)['holding_quantity']==1
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
# BOND-ANALYSIS-SCOPE-001: 同一页/跨页两债只按明确债券名称表头归属，不拼接持有人。
one=unranked.replace('前十名转债持有人情况如下：','可转换公司债券名称\n甲转债\n前十名转债持有人情况如下：')
two=unranked.replace('前十名转债持有人情况如下：','可转换公司债券名称\n乙转债\n前十名转债持有人情况如下：').replace('100000','200000')
holders.read_document=lambda *a: ([one,two],{'document_hash':'hash'})
assert holders.extract('url',bond_name='甲转债')['holding_quantity']==1
assert holders.extract('url',bond_name='乙转债')['holding_quantity']==2
try: holders.extract('url',bond_name='丙转债'); assert False
except ValueError: pass
prospectus=importlib.import_module('extractConvertibleBondProspectus')
assert len(prospectus.coupon_rates('第一年：0.2％，第二年利率为0.4%，第三年0.6%，第四年1.0%，第五年1.5%，第六年2.0%'))==6
# BOND-COUPON-HEADING-010: 明确章节利率表不因缺少票面/债券前缀而跳过。
prospectus.read_document=lambda *a: (['（三）利率\n第一年0.30%、第二年0.50%、第三年1.00%、第四年1.50%、第五年1.80%、第六年2.00%'],{'document_hash':'a'*64})
assert len(prospectus.extract('url')['coupon_rates'])==6
print('BOND-ANALYSIS-004: official identity, PDF cache, corruption, complete holder table and rating date passed')
`;
assert.ok(fs.existsSync(py));
const result=spawnSync(py,['-c',code],{cwd:root,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:30000});
assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
