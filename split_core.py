import io, re, sys

SRC = r'd:\Users\持仓跟踪\portfolio-server\public\shared\core.js'
OUT = r'd:\Users\持仓跟踪\portfolio-server\public\shared'

# 连续切片（1-indexed, 含端点）。空白分隔行(317/808/1366/1896/2390)略过无妨。
slices = [
    ('core-quote.js',    1,    316,  '行情/代码输入/粘贴导入'),
    ('core-tables.js',   318,  807,  '统计卡片/饼图/持仓表/交易表'),
    ('core-trade.js',    809,  1365, '交易录入/持仓增删改/截图AI/扫码/导入导出'),
    ('core-returns.js',  1367, 1895, '现金流/基金净值/收益对比图'),
    ('core-earnings.js', 1897, 2389, '页面切换/版本/收益页数据/历史净值导入'),
    ('core-account.js',  2391, 3007, '收益页渲染/全量渲染/自动刷新/账户管理'),
]

with io.open(SRC, 'r', encoding='utf-8') as f:
    lines = f.readlines()

errors = []
for fname, s, e, desc in slices:
    chunk = lines[s-1:e]
    if not chunk:
        errors.append(f'{fname}: 空切片 {s}-{e}')
        continue
    header = '// shared/%s – %s（原 core.js 拆分，全局作用域不变）\n' % (fname, desc)
    out = header + ''.join(chunk)
    with io.open(f'{OUT}\\{fname}', 'w', encoding='utf-8', newline='\n') as w:
        w.write(out)
    print('written', fname, 'lines', len(chunk))

# ---- 校验：拆分前后 function 定义集合一致 ----
def funcs(text):
    return set(re.findall(r'function\s+([A-Za-z_$][\w$]*)\s*\(', text))

orig = ''.join(lines)
split_all = ''
for fname, s, e, desc in slices:
    with io.open(f'{OUT}\\{fname}', 'r', encoding='utf-8') as f:
        split_all += f.read() + '\n'

orig_f = funcs(orig)
split_f = funcs(split_all)
missing = orig_f - split_f
extra = split_f - orig_f
print('orig functions:', len(orig_f), 'split functions:', len(split_f))
if missing:
    print('!!! 缺失函数:', sorted(missing))
    errors.append('missing functions')
if extra:
    print('+++ 多出函数(应无):', sorted(extra))
    errors.append('extra functions')

# 校验：原 core.js 顶层 let/const/var 声明在拆分后仍存在（无重复无遗漏）
topdecl = set(re.findall(r'^(?:let|const|var)\s+([A-Za-z_$][\w$]*)', orig, re.M))
split_decl = set()
for m in re.finditer(r'^(?:let|const|var)\s+([A-Za-z_$][\w$]*)', split_all, re.M):
    split_decl.add(m.group(1))
miss_decl = topdecl - split_decl
print('orig top-level decls:', len(topdecl), 'split decls:', len(split_decl))
if miss_decl:
    print('!!! 缺失顶层声明:', sorted(miss_decl))
    errors.append('missing top-level decls')

if errors:
    print('ERRORS:', errors)
    sys.exit(1)
print('OK: 拆分前后函数与顶层声明完全一致')
