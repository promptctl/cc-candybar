"""Union-find over strong code overlaps -> clone families (families.json)."""
import json
from collections import defaultdict

m = json.load(open('/tmp/ccland/measure.json'))
sel = {q['slug']: q for q in json.load(open('/tmp/ccland/selected.json'))}
meta = json.load(open('/tmp/ccland/meta.json'))
par = {s: s for s in m}


def find(x):
    while par[x] != x:
        par[x] = par[par[x]]; x = par[x]
    return x


for s, x in m.items():
    for o, n, a, b in x['shares']:
        if n >= 50 and max(a, b) >= 0.5:  # most of one project's statusline code is in the other
            par[find(s)] = find(o)
fam = defaultdict(list)
for s in m:
    fam[find(s)].append(s)
out = []
for members in fam.values():
    if len(members) < 2:
        continue
    def info(s):
        q = sel[s]
        return dict(slug=s, repo=q['repo'], stars=int(q.get('stars')) if str(q.get('stars')).isdigit() else 0, commits=q['own_commits'],
                    created=(meta.get(q['repo']) or {}).get('created'), sl_loc=m[s]['sl_loc'])
    ms = sorted((info(s) for s in members), key=lambda i: (i['created'] or '9'))
    out.append(dict(size=len(ms), oldest=ms[0]['repo'], top_starred=max(ms, key=lambda i: i['stars'])['repo'], members=ms))
out.sort(key=lambda f: -f['size'])
json.dump(out, open('/tmp/ccland/families.json', 'w'), indent=1)
print(len(out), 'families covering', sum(f['size'] for f in out), 'projects')
for f in out[:25]:
    print(f['size'], 'top-starred', f['top_starred'], 'oldest', f['oldest'], [i['repo'] for i in f['members']][:6])
