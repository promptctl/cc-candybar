import json, os
recs = {}
for l in open("/tmp/ccsl/signals.jsonl"):
    x = json.loads(l)
    recs[x["key"]] = x
rows = json.load(open("/tmp/ccsl/rows.json"))
sysr = sorted([r for r in rows if r["tier"] == "system"], key=lambda r: (-r["stars"], r["key"]))
os.makedirs("/tmp/ccsl/batches", exist_ok=True)
SIZE = 25

def compact(x):
    s = x.get("signals", {})
    counts = ", ".join("%s=%d" % (k, v["count"]) for k, v in sorted(s.items()) if isinstance(v, dict) and "count" in v)
    th = x.get("themes", {})
    names = sorted(set(th.get("from_paths", [])) | set(th.get("named_in_content", [])))
    meta = x.get("meta") or {}
    lines = ["- %s  (%s)  stars=%s%s" % (x["key"], x["url"], meta.get("stars", "n/a"),
             ("  FORK OF " + meta["fork_of"] + ": report only what differs from the parent") if meta.get("fork_of") else ""),
             "  files the extractor read: " + ", ".join(x.get("files", [])[:20]),
             "  signal counts: " + counts]
    if names:
        lines.append("  theme names seen: " + ", ".join(names))
    if x.get("theme_paths", {}).get("samples"):
        lines.append("  theme paths: " + ", ".join(x["theme_paths"]["samples"]))
    return "\n".join(lines)

n = 0
for i in range(0, len(sysr), SIZE):
    n += 1
    chunk = sysr[i:i + SIZE]
    with open("/tmp/ccsl/batches/batch-%02d.md" % n, "w") as f:
        f.write("\n".join(compact(recs[r["key"]]) for r in chunk) + "\n")
print(n, "batches")
