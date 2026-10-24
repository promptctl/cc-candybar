#!/usr/bin/env python3
"""Cut the map step's rows into the subsets the README writer reads.

Usage: focus.py <all.tsv> <rows.json> <outdir>

Writes <outdir>/rows.tsv (every row, a stars column first, sorted by stars) and
one focus-<name>.tsv per question the survey answers for cc-candybar's colour
system, each holding only the columns that question needs.
"""
import json
import os
import sys

COLS = ["source", "name", "url", "kind", "seg", "seg_detail", "themes", "depth",
        "fill", "sep", "neighbours", "lightdark", "notable"]


def key_of(url):
    return url.split("://", 1)[-1].rstrip("/").removesuffix(".git").lower()


def main(tsv, rows_json, out):
    stars = {r["key"].lower(): r.get("stars") or 0 for r in json.load(open(rows_json))}
    rows = []
    for line in open(tsv, encoding="utf-8"):
        if line.strip():
            r = dict(zip(COLS, line.rstrip("\n").split("\t")))
            r["stars"] = stars.get(key_of(r["url"]), 0)
            rows.append(r)
    rows.sort(key=lambda r: -r["stars"])
    os.makedirs(out, exist_ok=True)

    def write(name, pick, cols):
        path = os.path.join(out, name)
        with open(path, "w", encoding="utf-8") as f:
            for r in rows:
                if pick(r):
                    f.write("\t".join(str(r[c]) for c in ["stars"] + cols) + "\n")
        print(path, sum(1 for _ in open(path)))

    sl = lambda r: r["kind"] == "statusline"
    write("rows.tsv", lambda r: True, COLS)
    write("focus-role.tsv", lambda r: sl(r) and "role" in r["seg"],
          ["source", "name", "url", "seg", "seg_detail", "themes", "neighbours", "notable"])
    write("focus-position.tsv", lambda r: sl(r) and "position" in r["seg"],
          ["source", "name", "url", "seg", "seg_detail", "fill", "neighbours", "notable"])
    write("focus-neighbours.tsv",
          lambda r: sl(r) and any(c in r["neighbours"] for c in ("lightness", "alternate")),
          ["source", "name", "url", "seg", "fill", "sep", "neighbours", "notable"])
    write("focus-bgfill.tsv", lambda r: sl(r) and r["fill"] in ("bg", "both"),
          ["source", "name", "url", "seg", "seg_detail", "sep", "neighbours"])
    write("focus-lightdark.tsv",
          lambda r: sl(r) and not r["lightdark"].startswith("none"),
          ["source", "name", "url", "depth", "lightdark", "notable"])
    write("focus-top.tsv", lambda r: sl(r) and r["stars"] >= 200,
          ["source", "name", "url", "seg", "seg_detail", "themes", "fill", "sep", "neighbours",
           "lightdark", "notable"])


if __name__ == "__main__":
    main(*sys.argv[1:4])
