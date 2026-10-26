"""Split selected projects into agent batches and render each prompt from brief.md."""
import json, os, sys

SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 20
sel = json.load(open('/tmp/ccland/selected.json'))
meas = json.load(open('/tmp/ccland/measure.json'))
brief = open('/tmp/ccland/brief.md').read()
by_slug = {q['slug']: q for q in sel}
nb = (len(sel) + SIZE - 1) // SIZE
batches = [[] for _ in range(nb)]
for i, q in enumerate(sel):  # round-robin so each batch mixes large and small projects
    batches[i % nb].append(q)
os.makedirs('/tmp/ccland/prompts', exist_ok=True)
os.makedirs('/tmp/ccland/out', exist_ok=True)


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
            by_slug[o]['repo'] if o in by_slug else o, n, 100 * a, 100 * b, o) for o, n, a, b in m['shares'][:5]))
    return '\n'.join(lines)


for i, b in enumerate(batches, 1):
    out = '/tmp/ccland/out/batch-%02d.md' % i
    p = brief.replace('{{COUNT}}', str(len(b))).replace('{{OUTFILE}}', out).replace(
        '{{BATCH}}', '\n\n'.join(entry(q) for q in b))
    open('/tmp/ccland/prompts/batch-%02d.txt' % i, 'w').write(p)
print(nb, 'batches written')
