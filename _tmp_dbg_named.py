import sys, re
sys.path.insert(0, 'server/scripts')
import extractArbitrageDocument as ex
from extractArbitrageDocument import _to_num, _norm_name, RE_SWAP_NAMED, RE_COMPANY

URL = "https://static.cninfo.com.cn/finalpage/2026-05-15/1225307018.PDF"
text = ex.fetch_pdf_text(URL) if hasattr(ex,'fetch_pdf_text') else None
# fallback: replicate download
if not text:
    import urllib.request
    req = urllib.request.Request(URL, headers={'User-Agent':'Mozilla/5.0'})
    data = urllib.request.urlopen(req, timeout=30).read()
    import io
    try:
        import fitz
        doc = fitz.open(stream=data, filetype='pdf')
        text = '\n'.join(p.get_text() for p in doc)
    except Exception as e:
        print('fitz fail', e); text=''

text = re.sub(r'\s+', ' ', text)
m = re.search(r'换股吸收合并', text)
print('STRUCT pos=', m.start() if m else None)
before = text[max(0, m.start()-40):m.start()]
print('BEFORE 40 chars:', repr(before))
co = list(RE_COMPANY.finditer(before))
print('companies before:', [c.group(1) for c in co])
absorber_norm = _norm_name(co[-1].group(1)) if co else None
print('absorber_norm=', absorber_norm)

for nm in RE_SWAP_NAMED.finditer(text):
    g1n=_to_num(nm.group(1)); ca=_norm_name(nm.group(2)); g2n=_to_num(nm.group(3)); cb=_norm_name(nm.group(4))
    print('NAMED match:', dict(g1n=g1n, ca=ca, g2n=g2n, cb=cb, pos=nm.start()))
    absorber_is_ca = bool(absorber_norm and (ca==absorber_norm or absorber_norm in ca or ca in absorber_norm))
    print('  absorber_is_ca=', absorber_is_ca, '-> swap=', (g1n/g2n if absorber_is_ca else g2n/g1n), 'ref=', (ca if absorber_is_ca else cb))
