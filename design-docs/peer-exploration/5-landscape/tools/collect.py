"""Parse every out/batch-*.md into rows.json and report missing/malformed sections."""
import glob, json, re, sys

FIELDS = ['url', 'what', 'size', 'shape', 'data sources', 'lineage', 'why it exists', 'beyond baseline', 'summary']
sel = json.load(open('/tmp/ccland/selected.json'))
want = {q['repo'].lower() for q in sel}
rows, bad = {}, []
for f in sorted(glob.glob('/tmp/ccland/out/batch-*.md')):
    text = open(f).read()
    for sec in re.split(r'^## ', text, flags=re.M)[1:]:
        head, _, body = sec.partition('\n')
        repo = head.strip().strip('`')
        r = {'batch': f.rsplit('/', 1)[1], 'repo': repo}
        for fld in FIELDS:
            pat = {'why it exists': r'why(?: it exists)?', 'beyond baseline': r'beyond(?: baseline)?'}.get(fld, re.escape(fld))
            m = re.search(r'^- %s:\s*(.*?)(?=^- [a-z ]+:|\Z)' % pat, body, re.M | re.S)
            r[fld] = m.group(1).strip() if m else None
        miss = [k for k in FIELDS if not r[k]]
        if miss:
            bad.append((repo, f, miss))
        key = repo.lower()
        if key not in want:
            m2 = [w for w in want if w.split('/')[-1] == key.split('/')[-1]]
            if len(m2) == 1:
                key = m2[0]; r['repo'] = key
        rows[key] = r
json.dump(rows, open('/tmp/ccland/rows.json', 'w'), indent=1)
got = set(rows)
print(len(rows), 'sections;', len(bad), 'malformed;', len(want - got), 'selected projects without a section;',
      len(got - want), 'sections not matching a selected repo')
for b in bad[:20]:
    print('malformed', b)
if len(sys.argv) > 1:
    for r in sorted(want - got)[:50]:
        print('missing', r)
