import json, os, re, glob
D = "/Users/bmf/code/cc-candybar/.claude/worktrees/jiggly-leaping-sunbeam/design-docs/peer-exploration/4-styling/"
recs = [json.loads(l) for l in open("/tmp/ccsl/signals.jsonl")]
rows = {r["key"]: r for r in json.load(open("/tmp/ccsl/rows.json"))}
merged = {json.loads(l)["key"]: json.loads(l) for l in open("/tmp/ccsl/merged.jsonl")}

# which deep file holds each project's section: batch files list keys in order
where = {}
for path in sorted(glob.glob("/tmp/ccsl/batches/*.md")):
    name = os.path.basename(path)
    for line in open(path):
        m = re.match(r"- (\S+)\s", line)
        if m:
            where[m.group(1)] = "deep/" + name

def n(s, k):
    v = s.get(k)
    return v.get("count", 0) if isinstance(v, dict) else 0

def cell(x):
    return str(x).replace("|", "\\|").replace("\n", " ")

out = []
for x in recs:
    k = x["key"]
    meta = x.get("meta") or {}
    stars = meta.get("stars")
    s = x.get("signals") or {}
    r = rows.get(k)
    depth = []
    for d, label in (("16", "16"), ("256", "256"), ("truecolor", "24bit")):
        if n(s, "color.fg_" + d) or n(s, "color.bg_" + d):
            depth.append(label)
    th = x.get("themes") or {}
    names = sorted(set(th.get("from_paths", [])) | set(th.get("named_in_content", [])))
    ev = x.get("claude_evidence") or {}
    out.append((stars or 0, [
        k, x.get("url", ""), stars if stars is not None else "",
        x.get("status", "").split(":")[0],
        "Y" if (ev.get("fields") or ev.get("statusLine_setting")) else ("-" if x.get("status") != "ok" else "N"),
        r["tier"] if r else "",
        "/".join(depth) or "-",
        "Y" if any(n(s, "color.bg_" + d) for d in ("16", "256", "truecolor")) else "-",
        "Y" if n(s, "glyph.powerline") else "-",
        "Y" if n(s, "glyph.nerd_font") else "-",
        ", ".join(names[:6]) + (" …" if len(names) > 6 else ""),
        "/".join(t for t, key in (("NO_COLOR", "env.NO_COLOR"), ("COLORTERM", "env.COLORTERM")) if n(s, key)) or "-",
        ("[section](%s)" % where[k]) if k in where else "",
        (merged.get(k, {}).get("desc") or meta.get("description") or "")[:140],
    ]))
out.sort(key=lambda t: (-t[0], t[1][0]))
hdr = ["project", "url", "stars", "fetch", "claude statusline?", "tier", "colour depth", "bg fill", "powerline", "nerd font", "theme names seen", "env honoured", "deep read", "description"]
with open(D + "all-projects.md", "w") as f:
    f.write("# Every Claude Code statusline found, with its styling signals\n\n")
    f.write("%d projects, merged from discovery-github.md, discovery-registries.md and discovery-web.md, then read by a script (`/tmp/ccsl/extract.py`) on 2026-10-24. Columns are what the script found in each project's own statusline files; `deep read` links to a section an agent wrote from reading the code. `tier`: system = themes, palette files or colour config; hardcoded = colours written in code; nocolor = no colour at all; irrelevant = none of Claude Code's statusline stdin fields in its files.\n\n" % len(out))
    f.write("| " + " | ".join(hdr) + " |\n|" + "---|" * len(hdr) + "\n")
    for _, c in out:
        f.write("| " + " | ".join(cell(v) for v in c) + " |\n")
print(len(out), "rows")
