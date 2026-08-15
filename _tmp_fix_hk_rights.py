import subprocess, json, os, time
from collections import defaultdict

os.chdir('D:/Users/存在小站/portfolio-server')
PSQL = r'C:\pgsql\bin\psql.exe'
DB = 'postgresql://postgres:postgres@127.0.0.1:5432/portfolio'

# 1. 取所有 hk_rights case 的全部文档 URL（按 case 分组）
raw = subprocess.run(
    [PSQL, DB, '-t', '-c',
     "SELECT c.case_id, d.url FROM event.arbitrage_cases c "
     "JOIN event.arbitrage_case_documents acd ON acd.case_id=c.case_id "
     "JOIN event.documents d ON acd.document_id=d.document_id "
     "WHERE c.strategy_type='hk_rights' "
     "ORDER BY c.case_id, d.document_id"],
    capture_output=True, text=True
)
by_case = defaultdict(list)
for line in raw.stdout.strip().split('\n'):
    if not line.strip():
        continue
    parts = line.split('|', 1)
    if len(parts) != 2:
        continue
    cid = parts[0].strip()
    url = parts[1].strip()
    if url:
        by_case[cid].append(url)

print(f"共 {len(by_case)} 个 case 待处理", flush=True)

# 2. 逐 case 逐文档尝试提取代码（取第一篇成功提取的）
results = {}
for cid, urls in by_case.items():
    code = '?'
    for url in urls[:3]:  # 最多试前3篇
        try:
            out = subprocess.run(
                ['./venv/Scripts/python.exe', 'server/scripts/extractArbitrageDocument.py', url],
                capture_output=True, text=True, timeout=60
            )
            d = json.loads(out.stdout.strip())
            codes = d.get('target_codes', [])
            if codes:
                code = codes[0]
                break
        except Exception as e:
            continue
    results[cid] = code
    print(f"  case {cid} -> {code}", flush=True)

# 持久化提取结果
with open('_tmp_hkrights_codes.json', 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

# 3. 生成候选 canonical_code 并查库
candidates = set()
for cid, code in results.items():
    if code in ('?', 'ERR') or not code:
        continue
    try:
        n = int(code)
        candidates.add(f"{n:05d}.HK")
        candidates.add(f"{n:05d}")
    except ValueError:
        # 含字母（如 60080 之类），原样尝试
        candidates.add(code)

code_map = {}
if candidates:
    in_list = "','".join(candidates)
    map_raw = subprocess.run(
        [PSQL, DB, '-t', '-c',
         f"SELECT canonical_code, instrument_id FROM core.instruments WHERE canonical_code IN ('{in_list}')"],
        capture_output=True, text=True
    )
    for line in map_raw.stdout.strip().split('\n'):
        parts = [p.strip() for p in line.split('|')]
        if len(parts) == 2 and parts[0] and parts[1].isdigit():
            code_map[parts[0]] = int(parts[1])

print(f"\n库内匹配到 {len(code_map)} 个代码", flush=True)

# 4. 映射 + 生成 UPDATE
updates = {}
unmapped = []
for cid, code in results.items():
    if code in ('?', 'ERR') or not code:
        unmapped.append((cid, code))
        continue
    iid = None
    try:
        n = int(code)
        cand1 = f"{n:05d}.HK"
        cand2 = f"{n:05d}"
        if cand1 in code_map:
            iid = code_map[cand1]
        elif cand2 in code_map:
            iid = code_map[cand2]
    except ValueError:
        if code in code_map:
            iid = code_map[code]
    if iid:
        updates[cid] = iid
    else:
        unmapped.append((cid, code))

print(f"可修复 {len(updates)} 条，未匹配 {len(unmapped)} 条", flush=True)
for cid, code in unmapped:
    print(f"  UNMAPPED case {cid} code={code}", flush=True)

grp = defaultdict(list)
for cid, iid in updates.items():
    grp[iid].append(cid)

with open('_tmp_hkrights_update.sql', 'w', encoding='utf-8') as f:
    for iid, cids in grp.items():
        f.write(f"UPDATE event.arbitrage_cases SET target_instrument_id={iid} WHERE case_id IN ({','.join(cids)});\n")

print(f"\nSQL 已写入 _tmp_hkrights_update.sql（{len(grp)} 条 UPDATE）", flush=True)
