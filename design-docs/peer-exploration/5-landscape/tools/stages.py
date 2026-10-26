"""Turn a run's agent sections into classifier inputs and prompts.

usage: CCLAND_RUN=<dir> stages.py items   -> items.json, cls/in-NN.tsv + prompt-NN.md, why-keys.json, cls/why-in-N.tsv + why-prompt-N.md
       CCLAND_RUN=<dir> stages.py novel   -> cls/nov-in-N.tsv + nov-prompt-N.md, from other.json (after famcount.py)
Run collect.py first; this reads rows.json.
"""
import json, os, re, sys

RUN = os.environ.get('CCLAND_RUN', '/tmp/ccland')
CLS = os.path.join(RUN, 'cls')
os.makedirs(CLS, exist_ok=True)
one_line = lambda s, n: (s or '').replace('\t', ' ').replace('\n', ' ')[:n]


def chunks(n, size):
    k = max(1, (n + size - 1) // size)
    step = (n + k - 1) // k
    return [(a, min(a + step, n)) for a in range(0, n, step)]


def write(prefix, brief, lines, size, inkey, outkey):
    """prefix '' gives in-NN/out-NN/prompt-NN, the names famcount.py globs for features."""
    p = prefix + '-' if prefix else ''
    for i, (a, b) in enumerate(chunks(len(lines), size), 1):
        inp, out = os.path.join(CLS, '%sin-%02d.tsv' % (p, i)), os.path.join(CLS, '%sout-%02d.tsv' % (p, i))
        open(inp, 'w').write(''.join(lines[a:b]))
        open(os.path.join(CLS, '%sprompt-%02d.md' % (p, i)), 'w').write(brief.replace(inkey, inp).replace(outkey, out))
    print(prefix or 'features', len(lines), 'lines in', len(chunks(len(lines), size)), 'chunks')


if sys.argv[1] == 'items':
    r = json.load(open(os.path.join(RUN, 'rows.json')))
    items = []
    for k, x in r.items():
        b = x.get('beyond baseline') or ''
        if b.strip().lower().startswith('none'):
            continue
        for it in re.split(r';\s+(?![^()]*\))', b):  # a semicolon inside a file anchor's parens is not a separator
            it = one_line(re.sub(r'\s*\([^()]*\)\s*$', '', it.strip()), 400)
            if it:
                items.append((k, it))
    json.dump(items, open(os.path.join(RUN, 'items.json'), 'w'))
    write('', open('/tmp/ccland/classify-brief.md').read(),
          ['%d\t%s\n' % (j, it) for j, (_, it) in enumerate(items)], 440, '{{INFILE}}', '{{OUTFILE}}')
    keys = sorted(r)
    json.dump(keys, open(os.path.join(RUN, 'why-keys.json'), 'w'))
    write('why', open('/tmp/ccland/why-brief.md').read(),
          ['%d\t%s || %s\n' % (j, one_line(r[k]['what'], 200), one_line(r[k]['why it exists'], 300)) for j, k in enumerate(keys)],
          500, '{{IN}}', '{{OUT}}')
elif sys.argv[1] == 'novel':
    o = json.load(open(os.path.join(RUN, 'other.json')))
    write('nov', open('/tmp/ccland/novel-brief.md').read(),
          ['%d\t%s\t%s\t%s\n' % (j, p, one_line(c, 80), one_line(it, 400)) for j, (p, c, it) in enumerate(o)],
          420, '{{IN}}', '{{OUT}}')
