import subprocess, json, os
os.chdir('D:/Users/存在小站/portfolio-server')
PSQL = r'C:/pgsql/bin/psql.exe'
DB = 'postgresql://postgres:postgres@127.0.0.1:5432/portfolio'
cases = [8,17,27,44,49,68,106,111]

# 取每个case所有文档URL
for cid in cases:
    raw = subprocess.run([PSQL, DB, '-t', '-c',
        f"SELECT d.url FROM event.arbitrage_case_documents acd JOIN event.documents d ON acd.document_id=d.document_id WHERE acd.case_id={cid}"],
        capture_output=True, text=True)
    urls = [l.strip() for l in raw.stdout.strip().split('\n') if l.strip()]
    print(f"=== case {cid} ({len(urls)} docs) ===", flush=True)
    found = None
    for url in urls:
        try:
            out = subprocess.run(['./venv/Scripts/python.exe','server/scripts/extractArbitrageDocument.py',url],
                capture_output=True, text=True, timeout=60)
            d = json.loads(out.stdout.strip())
            codes = d.get('target_codes', [])
            if codes:
                found = codes[0]
                print(f"  FOUND code={found} url={url[:60]}", flush=True)
                break
        except Exception as e:
            pass
    if not found:
        print(f"  NO CODE in any doc", flush=True)
    # 同时打印标题辅助人工判断
    t = subprocess.run([PSQL, DB, '-t', '-c', f"SELECT LEFT(title,40) FROM event.arbitrage_cases WHERE case_id={cid}"],
        capture_output=True, text=True)
    print(f"  title: {t.stdout.strip()}", flush=True)
