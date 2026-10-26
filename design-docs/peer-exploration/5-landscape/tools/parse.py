import re, json, sys
from collections import Counter

src = sys.argv[1]
out = []
for l in open(src):
    if not l.startswith('| ') or l.startswith('| project') or l.startswith('|---'):
        continue
    f = [x.strip() for x in l.rstrip('\n').strip('|').split(' | ')]
    if len(f) < 14:
        continue
    name, url, stars, fetch, isl, tier = f[0], f[1], f[2], f[3], f[4], f[5]
    deep = f[12]
    desc = ' | '.join(f[13:])
    rec = dict(name=name, url=url, stars=stars, fetch=fetch, statusline=isl, tier=tier, deep=deep, desc=desc)
    m = re.match(r'https?://github\.com/([^/]+)/([^/#?]+)', url)
    g = re.match(r'https?://gist\.github\.com/(?:[^/]+/)?([0-9a-f]{20,})', url)
    gl = re.match(r'https?://(gitlab\.com|codeberg\.org)/([^/]+/[^/#?]+)', url)
    if g:
        rec['kind'] = 'gist'; rec['id'] = g.group(1)
    elif m:
        rec['kind'] = 'gh'; rec['id'] = (m.group(1) + '/' + re.sub(r'\.git$', '', m.group(2))).lower()
    elif gl:
        rec['kind'] = gl.group(1); rec['id'] = gl.group(2)
    else:
        rec['kind'] = 'other'
    out.append(rec)
json.dump(out, open('/tmp/ccland/projects.json', 'w'))
print(len(out), Counter(r['kind'] for r in out))
print(Counter((r['kind'], r['statusline']) for r in out))
print('unique gh ids', len({r['id'] for r in out if r['kind'] == 'gh'}))
