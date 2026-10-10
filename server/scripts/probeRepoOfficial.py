"""Only the existing permission probe calls this official cross-check. No rate facts or scheduler."""
import sys, json, hashlib, re
from pathlib import Path
from datetime import date
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ipo-report'))
from external_call_guard import guarded_urlopen
from urllib.request import Request
from urllib.parse import urlencode

SQL_ID='COMMON_SSEBOND_SCSJ_SCTJ_SCGL_ZQZYSHGSCGL_CX_L'
URL='https://query.sse.com.cn/commonQuery.do'
PAGE='https://bond.sse.com.cn/data/statistics/overview/Pledgerepo/'
def probe(target):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',target): raise ValueError('invalid official target date')
    date.fromisoformat(target)
    def parse(content, request_url):
        payload=json.loads(content.decode('utf-8'))
        rows=payload.get('result',[])
        total=payload.get('pageHelp',{}).get('total')
        if total is not None and int(total)>len(rows):raise ValueError('official cross-check pagination incomplete')
        matches=[r for r in rows if str(r.get('BOND_CODE'))=='204001' and str(r.get('BOND_NAME'))=='GC001' and str(r.get('TRADE_DATE','')).replace('-','')==target.replace('-','')]
        if len(matches)!=1:raise ValueError('official cross-check missing unique same-date GC001')
        row=matches[0]
        value=str(row.get('WEIGHT_RATE',''))
        if not re.fullmatch(r'\d+(?:\.\d+)?',value):raise ValueError('invalid official weighted percent')
        return {'date':target,'code':'204001.SH','metric':'daily_volume_weighted','unit':'percent','value':value,'label':'加权平均利率(%) / WEIGHT_RATE','sourceUrl':PAGE,'requestUrl':request_url,'contentHash':hashlib.sha256(content).hexdigest(),'payload':payload,'sqlId':SQL_ID}
    request_url=URL+'?'+urlencode({'sqlId':SQL_ID,'isPagination':'true','pageHelp.pageSize':100,'TRADE_DATE':target})
    with guarded_urlopen(Request(request_url,headers={'Referer':PAGE,'User-Agent':'Mozilla/5.0'}),timeout=20,source='sse',dataset='repo-official-admission:'+target,api_name='repo_overview') as response:
        return parse(response.read(),request_url)
if __name__=='__main__':
    try:print(json.dumps(probe(sys.argv[1]),ensure_ascii=False))
    except Exception as exc:print(json.dumps({'error':str(exc)},ensure_ascii=False));sys.exit(1)
