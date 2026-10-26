"""Split selected projects into agent batches and render each prompt from brief.md.

usage: batches.py [SIZE] [SELECTION] [MEASURE] [PROMPT_DIR] [OUT_DIR]
Defaults are the top-1,000 run's files.
"""
import json, os, sys

arg = lambda i, d: sys.argv[i] if len(sys.argv) > i else d
SIZE = int(arg(1, 20))
sel = json.load(open(arg(2, '/tmp/ccland/selected.json')))
meas = json.load(open(arg(3, '/tmp/ccland/measure.json')))
PROMPTS, OUT = arg(4, '/tmp/ccland/prompts'), arg(5, '/tmp/ccland/out')
brief = open('/tmp/ccland/brief.md').read().replace('{{CORPUS}}', '{:,}'.format(len(meas)))
# overlap names resolve against every project ever selected, not just this run's
names = {q['slug']: q['repo'] for f in ['/tmp/ccland/selected.json', '/tmp/ccland/t2/all.json'] if os.path.exists(f)
         for q in json.load(open(f))}
nb = (len(sel) + SIZE - 1) // SIZE
batches = [[] for _ in range(nb)]
for i, q in enumerate(sel):  # round-robin so each batch mixes large and small projects
    batches[i % nb].append(q)
os.makedirs(PROMPTS, exist_ok=True)
os.makedirs(OUT, exist_ok=True)


def entry(q):
    m = meas.get(q['slug'])
    lines = ['### ' + q['repo'],
             'url: ' + q['url'],
             'stars: %s; commits: %s total, %s in last 90 days, last %s%s' % (
                 q.get('stars'), q['own_commits'], q['recent_own'], (q.get('last') or '?')[:10],
                 '; FORK of %s (%s commits of its own)' % (q.get('parent'), q['own_commits']) if q.get('fork') else ''),
             'list description: ' + (q.get('desc') or '')[:300]]
    if not m:
        lines.append('local source: NOT DOWNLOADED (write the section as unreadable)')
        return '\n'.join(lines)
    lines.append('local source: /tmp/ccland/src/%s/ (%d code lines in repo)' % (q['slug'], m['repo_loc']))
    if m['sl_files']:
        lines.append('statusline files (%d, %d lines): ' % (m['n_sl_files'], m['sl_loc']) +
                     ', '.join('%s (%d)' % (f, n) for f, n in m['sl_files']))
    else:
        lines.append('statusline files: none found by the scanner; look for it yourself')
    lines.append('docs-example overlap: %d%%' % round(100 * m['docs_overlap']))
    if m['shares']:
        lines.append('overlaps: ' + '; '.join('%s shares %d fingerprints: %d%% of this project, %d%% of theirs (/tmp/ccland/src/%s/)' % (
            names.get(o, o), n, 100 * a, 100 * b, o) for o, n, a, b in m['shares'][:5]))
    return '\n'.join(lines)


for i, b in enumerate(batches, 1):
    out = os.path.join(OUT, 'batch-%03d.md' % i if nb > 99 else 'batch-%02d.md' % i)
    p = brief.replace('{{COUNT}}', str(len(b))).replace('{{OUTFILE}}', out).replace(
        '{{BATCH}}', '\n\n'.join(entry(q) for q in b))
    open(os.path.join(PROMPTS, os.path.basename(out)[:-3] + '.txt'), 'w').write(p)
print(nb, 'batches written')
