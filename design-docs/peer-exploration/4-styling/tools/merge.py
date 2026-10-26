import re, sys, json, collections
D = "/Users/bmf/code/cc-candybar/.claude/worktrees/jiggly-leaping-sunbeam/design-docs/peer-exploration/4-styling/"

def rows(path):
    for line in open(D + path, encoding="utf-8"):
        if not line.startswith("| ") or line.startswith("| repo |") or line.startswith("| name |"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        yield cells

def key(url):
    u = url.strip().lower().rstrip("/")
    u = re.sub(r"^https?://(www\.)?", "", u)
    u = re.sub(r"\.git$", "", u)
    m = re.match(r"github\.com/([^/#?]+)/([^/#?]+)", u)
    if m:
        return "github.com/%s/%s" % m.groups()
    m = re.match(r"gist\.github\.com/(?:[^/]+/)?([0-9a-f]{6,})", u)
    if m:
        return "gist/" + m.group(1)
    m = re.match(r"(gitlab\.com|codeberg\.org)/([^/#?]+)/([^/#?]+)", u)
    if m:
        return "%s/%s/%s" % m.groups()
    return u.split("#")[0]

out = collections.OrderedDict()
def add(k, url, src, desc, stars=None):
    e = out.setdefault(k, {"url": url, "sources": set(), "desc": desc, "stars": stars})
    e["sources"].add(src)
    if stars is not None and e["stars"] is None:
        e["stars"] = stars
    if not e["desc"] and desc:
        e["desc"] = desc

for c in rows("discovery-github.md"):
    if len(c) >= 6:
        st = int(c[2]) if c[2].isdigit() else None
        add(key(c[1]), c[1], "github", c[5], st)
for c in rows("discovery-registries.md"):
    if len(c) >= 5:
        url = c[1] if c[1].startswith("http") else c[3]
        add(key(url), url, "registry", c[4])
for c in rows("discovery-web.md"):
    if len(c) >= 4:
        add(key(c[1]), c[1], "web", c[3])

kinds = collections.Counter(k.split("/")[0] for k in out)
print("unique", len(out), dict(kinds.most_common(8)))
print("by source combo", collections.Counter(",".join(sorted(e["sources"])) for e in out.values()))
with open("/tmp/ccsl/merged.jsonl", "w") as f:
    for k, e in out.items():
        f.write(json.dumps({"key": k, "url": e["url"], "stars": e["stars"], "sources": sorted(e["sources"]), "desc": e["desc"]}) + "\n")
