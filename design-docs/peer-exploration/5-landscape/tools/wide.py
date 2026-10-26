"""Compare the agent-read tail (t2) with the top 1,000, by commit band.

usage: wide.py [rows|all]
  rows: kinds, shapes and lineage from the agents' sections (both runs' rows.json)
  all:  also feature families, motives and new ideas (needs both runs classified)
Writes t2/wide.json with every table, for build.py and the README.
"""
import json, re, sys
from collections import Counter, defaultdict

PART = sys.argv[1] if len(sys.argv) > 1 else 'rows'
runs = {'top': '/tmp/ccland', 'tail': '/tmp/ccland/t2'}
sel = {k: json.load(open(d + '/selected.json')) for k, d in runs.items()}
rows = {k: json.load(open(d + '/rows.json')) for k, d in runs.items()}
BANDS = ['45+ (top 1,000)', '20-44', '10-19', '5-9', '2-4', '0-1']


def band(run, q):
    c = q['own_commits']
    if run == 'top':
        return BANDS[0]
    return next(b for lo, b in [(20, '20-44'), (10, '10-19'), (5, '5-9'), (2, '2-4'), (0, '0-1')] if c >= lo)


def kind(w):
    w = (w or '').lower()
    for k, p in [('not a statusline', 'not a statusline'), ('unreadable', 'unreadable'), ('inside a larger tool', 'inside a larger'),
                 ('config or wrapper', 'config or wrapper'), ('dotfiles', 'personal dotfiles'), ('dedicated', 'dedicated')]:
        if w.startswith(p) or (p == 'inside a larger' and 'inside a larger' in w[:40]):
            return k
    return 'other'


def shape(s):
    s = (s or '').lower()
    return next((k for k in ['field printer', 'standard', 'rich', 'engine'] if s.startswith(k)), 'other')


def lineage(l):
    l = (l or '').lower()
    for k, p in [('fork', r'fork of'), ('copy', r'copies code from'), ('port', r'\bports?\b'), ('wrap', r'wraps or configures|wraps'),
                 ('credit', r'credits')]:
        if re.search(p, l):
            return k
    return 'none'


proj = {}  # key -> (run, band)
for run in runs:
    for q in sel[run]:
        k = q['repo'].lower()
        if k in rows[run]:
            proj[k] = (run, band(run, q))
out = {'bands': BANDS, 'read': Counter(b for _, b in proj.values())}
tab = defaultdict(lambda: defaultdict(Counter))
is_sl = set()  # families are shares of statuslines, so only statuslines are counted into them
for k, (run, b) in proj.items():
    r = rows[run][k]
    kd = kind(r['what'])
    tab['kind'][b][kd] += 1
    if kd in ('not a statusline', 'unreadable', 'other'):
        continue
    is_sl.add(k)
    tab['statuslines'][b]['n'] += 1
    tab['shape'][b][shape(r['shape'])] += 1
    tab['lineage'][b][lineage(r['lineage'])] += 1
    if (r['beyond baseline'] or '').strip().lower().startswith('none'):
        tab['nothing beyond baseline'][b]['n'] += 1

if PART == 'all':
    fam = {k: json.load(open(d + '/fam.json')) for k, d in runs.items()}
    names = json.load(open('/tmp/ccland/famnames.json'))
    for run in runs:
        for code, ps in fam[run].items():
            for p in ps:
                if p in is_sl:
                    tab['family'][proj[p][1]][code] += 1
    for run, d in runs.items():
        keys = json.load(open(d + '/why-keys.json'))
        import glob
        for f in sorted(glob.glob(d + '/cls/why-out-*.tsv')):
            for l in open(f):
                p = l.rstrip('\n').split('\t')
                if len(p) >= 2 and p[0].strip().isdigit() and keys[int(p[0])] in proj:
                    m = re.match(r'(M\d\d)', p[1].strip())
                    tab['motive'][proj[keys[int(p[0])]][1]][m.group(1) if m else 'other'] += 1
        nov = json.load(open(d + '/novel-groups.json'))
        for g, ps in nov.items():
            for p in ps:
                if p in proj:
                    tab['novel'][proj[p][1]][g] += 1
                    tab['novel projects'][proj[p][1]][p] += 1
    out['famnames'] = names
out['tables'] = {t: {b: dict(c) for b, c in v.items()} for t, v in tab.items()}
json.dump(out, open('/tmp/ccland/t2/wide.json', 'w'), indent=1)
for t, v in tab.items():
    if t == 'novel projects':
        print('\nnovel projects:', {b: len(v[b]) for b in BANDS})
        continue
    keys = sorted({k for b in BANDS for k in v[b]}, key=lambda k: -sum(v[b][k] for b in BANDS))
    print('\n' + t + '\t' + '\t'.join(b.split(' ')[0] for b in BANDS))
    for k in keys[:40]:
        print('  %-28s' % k[:28] + '\t'.join('%5d' % v[b][k] for b in BANDS))
print('\nread per band:', dict(out['read']))
