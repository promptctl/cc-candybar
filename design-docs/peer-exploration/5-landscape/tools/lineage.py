"""Who descends from whom: parents named in agents' lineage lines, by relation."""
import json, re
from collections import Counter, defaultdict

r = json.load(open('/tmp/ccland/rows.json'))
rel = defaultdict(Counter)
examples = defaultdict(list)
REL = [('fork', r'fork of'), ('copy', r'copies code from'), ('wrap', r'wraps or configures|wraps'),
       ('port', r'\bports?\b'), ('credit', r'credits')]
for k, x in r.items():
    if (x['what'] or '').lower().startswith(('not a statusline', 'unreadable')):
        continue
    l = x['lineage'] or ''
    for name, rx in REL:
        m = re.search('(?:' + rx + ')' + r'\s+([`\w./@-]+)', l, re.I)
        if m:
            parent = m.group(1).strip('`.,').lower()
            parent = parent.split('/')[-1] if '/' in parent else parent
            rel[parent][name] += 1
            if len(examples[parent]) < 4:
                examples[parent].append(k)
tot = Counter({p: sum(c.values()) for p, c in rel.items()})
for p, n in tot.most_common(30):
    print('%3d %-28s %s  e.g. %s' % (n, p, dict(rel[p]), ', '.join(examples[p][:3])))
