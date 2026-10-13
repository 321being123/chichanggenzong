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
print('BOND-ANALYSIS-004: official identity, PDF cache, corruption, complete holder table and rating date passed')
`;
assert.ok(fs.existsSync(py));
const result=spawnSync(py,['-c',code],{cwd:root,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:30000});
assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
