"""Statusline code size and creation date by commit band, over every downloaded project."""
import json
from statistics import median
from collections import defaultdict

m = json.load(open('/tmp/ccland/t2/measure.json'))
meta = json.load(open('/tmp/ccland/meta.json'))
top = json.load(open('/tmp/ccland/selected.json'))
tail = json.load(open('/tmp/ccland/t2/all.json'))
read = {q['slug'] for q in top} | {q['slug'] for q in json.load(open('/tmp/ccland/t2/selected.json'))}
BANDS = ['45+', '20-44', '10-19', '5-9', '2-4', '0-1']


def band(q, is_top):
    return '45+' if is_top else next(b for lo, b in [(20, '20-44'), (10, '10-19'), (5, '5-9'), (2, '2-4'), (0, '0-1')] if q['own_commits'] >= lo)


loc, made = defaultdict(list), defaultdict(list)
for qs, is_top in [(top, True), (tail, False)]:
    for q in qs:
        x = m.get(q['slug'])
        if x and x['sl_loc'] > 0:
            loc[band(q, is_top)].append(x['sl_loc'])
        c = (meta.get(q['repo']) or {}).get('created')
        if c and q['slug'] in read:
            made[band(q, is_top)].append(c[:7])
print('band\tn\tmedian\t<50\t<200\t>=1000\tread: median created, share created 2026-08 or later')
for b in BANDS:
    v = loc[b]
    c = sorted(made[b])
    print('%s\t%d\t%d\t%d%%\t%d%%\t%d%%\t%s\t%d%%' % (
        b, len(v), median(v), 100 * sum(x < 50 for x in v) / len(v), 100 * sum(x < 200 for x in v) / len(v),
        100 * sum(x >= 1000 for x in v) / len(v), c[len(c) // 2] if c else '-',
        100 * sum(x >= '2026-08' for x in c) / max(1, len(c))))
