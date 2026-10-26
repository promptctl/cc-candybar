"""Join classifier labels to items: per-family project counts, and the `other` bucket."""
import json, glob, re
from collections import defaultdict, Counter

items = json.load(open('/tmp/ccland/items.json'))
lab = {}
for f in sorted(glob.glob('/tmp/ccland/cls/out-*.tsv')):
    for l in open(f):
        if '\t' in l:
            i, c = l.rstrip('\n').split('\t', 1)
            if i.strip().isdigit():
                lab[int(i)] = c.strip()
print('labelled', len(lab), 'of', len(items))
fam = defaultdict(set)
other = []
for i, (proj, it) in enumerate(items):
    c = lab.get(i, '?')
    m = re.match(r'(F\d\d)', c)
    if m:
        fam[m.group(1)].add(proj)
    else:
        other.append((proj, c, it))
names = {l.split(' ', 1)[0]: l.split(' ', 1)[1].strip() for l in open('/tmp/ccland/classify-brief.md') if re.match(r'F\d\d ', l)}
for k, v in sorted(fam.items(), key=lambda kv: -len(kv[1])):
    print('%4d %s %s' % (len(v), k, names[k][:95]))
print('other items', len(other), 'projects', len({p for p, _, _ in other}))
json.dump({k: sorted(v) for k, v in fam.items()}, open('/tmp/ccland/fam.json', 'w'))
json.dump(names, open('/tmp/ccland/famnames.json', 'w'))
json.dump(other, open('/tmp/ccland/other.json', 'w'))
oc = Counter(re.sub(r'^other:\s*', '', c).lower() for _, c, _ in other)
print(oc.most_common(50))
