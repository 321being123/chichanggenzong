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
print('BOND-ANALYSIS-004: official identity, PDF cache, corruption, complete holder table and rating date passed')
`;
assert.ok(fs.existsSync(py));
const result=spawnSync(py,['-c',code],{cwd:root,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:30000});
assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
