"""Markdown tables for the README from t2/wide.json and the all-project measure, by commit band."""
import json
from statistics import median
from collections import Counter, defaultdict

w = json.load(open('/tmp/ccland/t2/wide.json'))
T = w['tables']
B = w['bands']
SHORT = ['45+', '20-44', '10-19', '5-9', '2-4', '0-1']
names = w['famnames']
sl = {b: T['statuslines'][b]['n'] for b in B}
read = w['read']

# copy share and size over every downloaded project, the same test clones.py uses
m = json.load(open('/tmp/ccland/t2/measure.json'))
top = {q['slug'] for q in json.load(open('/tmp/ccland/selected.json'))}
qs = {q['slug']: q for f in ['/tmp/ccland/selected.json', '/tmp/ccland/t2/all.json'] for q in json.load(open(f))}
cp, loc = Counter(), defaultdict(list)
for s, x in m.items():
    if s not in qs or x['sl_loc'] == 0:
        continue
    b = B[0] if s in top else next(bb for lo, bb in zip([20, 10, 5, 2, 0], B[1:]) if qs[s]['own_commits'] >= lo)
    loc[b].append(x['sl_loc'])
    cp[b] += any(a >= 0.5 and n >= 25 for o, n, a, _ in x['shares'])


def pct(n, d):
    return '%d%%' % round(100 * n / d) if d else '-'


def row(label, f):
    return '| %s | %s |' % (label, ' | '.join(f(b) for b in B))


head = '| | %s |\n|---|%s' % (' | '.join(SHORT), '---|' * len(B))
print(head)
print(row('projects read', lambda b: str(read[b])))
print(row('statuslines among them', lambda b: str(sl[b])))
print(row('median lines of statusline code (all downloaded)', lambda b: str(int(median(loc[b])))))
print(row('half or more copied from one other project (all downloaded)', lambda b: pct(cp[b], len(loc[b]))))
k = T['kind']
print(row('statusline inside a larger tool', lambda b: pct(k[b].get('inside a larger tool', 0), sl[b])))
for s in ['rich', 'engine', 'standard', 'field printer']:
    print(row('shape: ' + s, lambda b, s=s: pct(T['shape'][b].get(s, 0), sl[b])))
print(row('at least one genuinely new idea', lambda b: pct(len(T['novel projects'].get(b, {})), read[b])))
print()
print(head)
fam = T['family']
order = sorted(names, key=lambda c: -sum(fam[b].get(c, 0) for b in B))
for c in order:
    print(row('%s %s' % (c, names[c][:70]), lambda b, c=c: pct(fam[b].get(c, 0), sl[b])))
print()
print(head)
mot = T['motive']
for c in sorted({c for b in B for c in mot[b]}, key=lambda c: -sum(mot[b].get(c, 0) for b in B)):
    print(row(c, lambda b, c=c: pct(mot[b].get(c, 0), read[b])))
print()
nov = T['novel']
tot = Counter()
for b in B:
    tot.update(nov[b])
print(head)
for g, n in tot.most_common():
    print(row('%s (%d)' % (g, n), lambda b, g=g: str(nov[b].get(g, 0))))
