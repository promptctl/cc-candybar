"""Choose which of the remaining projects (t2/all.json) agents read, into t2/selected.json.

- 10-44 commits: all of them.
- 2-9 commits: those with at least MIN_LOC lines of statusline code that are not mostly
  a copy (>= CLONE of their fingerprints) of a project already chosen or in the top 1,000.
- 0-1 commits: the same test with BIG_LOC.
Copies are judged greedily in rank order, so of two mutual copies the more-committed is read.

usage: pick.py MEASURE_ALL [MIN_LOC] [BIG_LOC]
"""
import json, sys
from collections import Counter

meas = json.load(open(sys.argv[1]))
MIN_LOC = int(sys.argv[2]) if len(sys.argv) > 2 else 150
BIG_LOC = int(sys.argv[3]) if len(sys.argv) > 3 else 400
CLONE = 0.7
top = json.load(open('/tmp/ccland/selected.json'))
tail = json.load(open('/tmp/ccland/t2/all.json'))
chosen = {q['slug'] for q in top}
read, why = [], Counter()


def copy_of(m):
    return next((o for o, n, a, b in m['shares'] if a >= CLONE and o in chosen), None)


for q in tail:  # rank order: most commits first
    m = meas.get(q['slug'])
    c = q['own_commits']
    if c >= 10:
        read.append(q); chosen.add(q['slug']); why['10-44: all'] += 1; continue
    if not m:
        why['not downloaded'] += 1; continue
    floor = MIN_LOC if c >= 2 else BIG_LOC
    if m['sl_loc'] < floor:
        why['%s: under %d statusline lines' % ('2-9' if c >= 2 else '0-1', floor)] += 1; continue
    o = copy_of(m)
    if o:
        why['%s: copy of a chosen project' % ('2-9' if c >= 2 else '0-1')] += 1; continue
    read.append(q); chosen.add(q['slug']); why['%s: read' % ('2-9' if c >= 2 else '0-1')] += 1
json.dump(read, open('/tmp/ccland/t2/selected.json', 'w'))
for k, v in sorted(why.items()):
    print('%5d %s' % (v, k))
print(len(read), 'to read')
