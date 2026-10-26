"""Clone picture across every downloaded project (top 1,000 and the rest), by commit band.

usage: clones.py MEASURE_ALL -> t2/families-all.json, and a per-band table on stdout
A project is a copy when at least half of its statusline fingerprints sit in one other
project; a docs copy when half sit in the docs examples.
"""
import json, sys
from collections import defaultdict, Counter

m = json.load(open(sys.argv[1]))
qs = {q['slug']: q for f in ['/tmp/ccland/selected.json', '/tmp/ccland/t2/all.json'] for q in json.load(open(f))}
top = {q['slug'] for q in json.load(open('/tmp/ccland/selected.json'))}
par = {s: s for s in m}


def find(x):
    while par[x] != x:
        par[x] = par[par[x]]; x = par[x]
    return x


for s, x in m.items():
    for o, n, a, b in x['shares']:
        if n >= 50 and max(a, b) >= 0.5 and min(a, b) >= 0.2:  # the floor stops a monorepo holding several copied bars from chaining their families
            par[find(s)] = find(o)
fam = defaultdict(list)
for s in m:
    fam[find(s)].append(s)
fams = sorted((v for v in fam.values() if len(v) > 1), key=len, reverse=True)
member = {s: i for i, v in enumerate(fams) for s in v}


def band(s):
    c = qs[s]['own_commits']
    return '45+ (top 1,000)' if s in top else next(b for lo, b in [(20, '20-44'), (10, '10-19'), (5, '5-9'), (2, '2-4'), (0, '0-1')] if c >= lo)


rows = defaultdict(Counter)
for s, x in m.items():
    if s not in qs:
        continue
    b = band(s)
    r = rows[b]
    r['projects'] += 1
    if x['sl_loc'] == 0:
        r['no statusline code found'] += 1; continue
    r['with statusline code'] += 1
    if any(a >= 0.5 and n >= 25 for o, n, a, _ in x['shares']):
        r['half or more copied from another project'] += 1
    if x['docs_overlap'] >= 0.5:
        r['half or more from the docs examples'] += 1
    if s in member:
        r['in a clone family'] += 1
    r['statusline lines (sum)'] += x['sl_loc']
cols = ['projects', 'no statusline code found', 'with statusline code', 'half or more copied from another project',
        'half or more from the docs examples', 'in a clone family']
print('band\t' + '\t'.join(cols) + '\tmedian-ish lines')
for b in ['45+ (top 1,000)', '20-44', '10-19', '5-9', '2-4', '0-1']:
    r = rows[b]
    print(b + '\t' + '\t'.join(str(r[c]) for c in cols) + '\t%d' % (r['statusline lines (sum)'] / max(1, r['with statusline code'])))
out = []
for v in fams:
    ms = sorted(({'repo': qs[s]['repo'], 'commits': qs[s]['own_commits'], 'stars': qs[s].get('stars'), 'top1000': s in top,
                  'sl_loc': m[s]['sl_loc']} for s in v if s in qs), key=lambda i: -i['commits'])
    out.append({'size': len(ms), 'in_top1000': sum(i['top1000'] for i in ms), 'members': ms})
json.dump(out, open('/tmp/ccland/t2/families-all.json', 'w'), indent=1)
print(len(out), 'families covering', sum(f['size'] for f in out), 'projects')
for f in out[:25]:
    print(f['size'], f['in_top1000'], 'top-starred', max(f['members'], key=lambda i: int(i['stars']) if str(i['stars']).isdigit() else 0)['repo'], [i['repo'] for i in f['members']][:4])
print('docs-copy projects:', sum(1 for s, x in m.items() if x['docs_overlap'] >= 0.5))
