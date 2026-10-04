"""Whitelist package contents and scan the actual ZIP, not only Git ignore rules."""
from pathlib import Path
import json, re, sys, zipfile
root = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]).resolve()
allowed = {'programs','packages','schema','scripts','tools','idl','examples','docs','release','fixtures','.github'}
skip = {'node_modules','.git','target','dist','__pycache__'}
files = []
for p in sorted(root.rglob('*')):
    rel = p.relative_to(root)
    if not p.is_file() or any(part in skip for part in rel.parts): continue
    if len(rel.parts) > 1 and rel.parts[0] not in allowed: continue
    if p == out: continue
    if re.search(r'(keypair|wallet|secret|credential).*\.(json|pem|key)$',p.name,re.I) or p.name == 'id.json' or p.name.startswith('.env'): raise SystemExit(f'Forbidden path: {rel}')
    files.append(p)
out.parent.mkdir(parents=True, exist_ok=True)
# Reproducible: sorted entries, fixed timestamps and permissions, so the same tree always gives the same bytes.
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for p in files:
        info = zipfile.ZipInfo('open-app-registry/' + p.relative_to(root).as_posix(), date_time=(1980,1,1,0,0,0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o755 if p.stat().st_mode & 0o111 else 0o644) << 16
        z.writestr(info, p.read_bytes(), compresslevel=9)
with zipfile.ZipFile(out) as z:
    for name in z.namelist():
        if '..' in Path(name).parts: raise SystemExit('Unsafe archive path')
        if name.endswith('.json'):
            data = json.loads(z.read(name))
            if isinstance(data,list) and len(data) in (32,64) and all(type(v) is int and 0 <= v <= 255 for v in data): raise SystemExit('Signer-shaped JSON in ZIP')
        if (b'-----BEGIN ' + b'PRIVATE KEY-----') in z.read(name): raise SystemExit('Private key in ZIP')
print(f'{len(files)} files packaged; archive secret checks passed: {out}')
