"""How clone families change with a floor on the smaller side of the overlap (bridging check)."""
import json
from collections import defaultdict

m = json.load(open('/tmp/ccland/t2/measure.json'))
qs = {q['slug']: q for f in ['/tmp/ccland/selected.json', '/tmp/ccland/t2/all.json'] for q in json.load(open(f))}
for lo in [0, 0.1, 0.2, 0.3]:
    par = {s: s for s in m}

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]; x = par[x]
        return x

    for s, x in m.items():
        for o, n, a, b in x['shares']:
            if n >= 50 and max(a, b) >= 0.5 and min(a, b) >= lo:
                par[find(s)] = find(o)
    fam = defaultdict(list)
    for s in m:
        fam[find(s)].append(s)
    fs = sorted((v for v in fam.values() if len(v) > 1), key=len, reverse=True)
    print(lo, len(fs), 'families', sum(map(len, fs)), 'projects; largest', [len(v) for v in fs[:8]])
    for v in fs[:4]:
        v.sort(key=lambda s: -qs.get(s, {}).get('own_commits', 0))
        print('   ', [qs[s]['repo'] for s in v[:6] if s in qs])
