#!/usr/bin/env python3
"""Extract styling signals from every Claude Code statusline project in a list.

Reads one project per line from --input (fields: key, url, desc), reads each project's
own styling-relevant files, and appends one JSON record per project to --out. A rerun
skips every key --out already holds, so an interrupted run resumes where it stopped.

Standard library only. GitHub is authenticated with the token `gh auth token` prints.

  python3 extract.py --out signals.jsonl                    # every project
  python3 extract.py --out t.jsonl --limit 40 --keys K1 K2  # first 40 plus K1, K2
"""
from __future__ import annotations

import argparse
import bisect
import concurrent.futures as cf
import hashlib
import html
import html.parser
import http.client
import io
import json
import os
import re
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Callable, Iterable

MAX_FILES = 20
MAX_FILE_BYTES = 200_000
MAX_PAGE_BYTES = 4_000_000
MAX_ARCHIVE_BYTES = 60_000_000
GQL_BATCH = 100
SAMPLES = 3
SAMPLE_CHARS = 160
USER_AGENT = "ccsl-extract/1.0 (statusline styling survey)"

# ───────────────────────────── outcomes ─────────────────────────────
# [LAW:single-enforcer] A project that ends without being read raises one of these; the one
# try/except in `process` turns it into the record's status. Nothing else picks a status.


class Outcome(Exception):
    status = "error"


class NotFound(Outcome):
    status = "not_found"


class Empty(Outcome):
    status = "empty"


class NoCandidates(Outcome):
    status = "no_candidate_files"


class Skipped(Outcome):
    status = "non_github_skipped"


# ───────────────────────────── http ─────────────────────────────


@dataclass(frozen=True)
class Reply:
    status: int
    headers: dict  # lower-cased names
    body: bytes
    url: str

    def json(self):
        return json.loads(self.body)

    def text(self) -> str:
        return decode(self.body)


GITHUB_AUTH_HOSTS = {"api.github.com", "raw.githubusercontent.com"}
RETRY_STATUSES = {429, 500, 502, 503, 504}
# (attempts, seconds per socket operation). GitHub is worth waiting for; a page host that
# does not answer in 3 x 20 s is recorded as an error rather than holding a worker for minutes.
PATIENCE_GITHUB = (6, 40)
PATIENCE_OTHER = (3, 20)


class Http:
    """The one owner of network access: retries, backoff, and GitHub's quota.

    [LAW:no-shared-mutable-globals] The quota state (remaining/reset per GitHub resource) is
    written only here, under `_lock`, from the headers of every API reply.
    """

    def __init__(self, token: str, api_slots: int):
        self._token = token
        self._api = threading.Semaphore(api_slots)
        self._lock = threading.Lock()
        self.limits: dict[str, tuple[int, int]] = {}  # resource -> (remaining, reset epoch)

    def get(self, url: str, *, data: bytes | None = None, headers: dict | None = None) -> Reply:
        host = urllib.parse.urlsplit(url).hostname or ""
        api = host == "api.github.com"
        resource = "graphql" if api and url.endswith("/graphql") else "core"
        hdrs = {"User-Agent": USER_AGENT, **(headers or {})}
        if host in GITHUB_AUTH_HOSTS:  # the token never leaves GitHub
            hdrs["Authorization"] = f"Bearer {self._token}"
        if api:
            hdrs.setdefault("Accept", "application/vnd.github+json")
        attempts, timeout = PATIENCE_GITHUB if host.endswith(("github.com", "githubusercontent.com")) else PATIENCE_OTHER
        attempt, last = 0, "no attempt"
        while attempt < attempts:
            if api:
                self._await_quota(resource)
                with self._api:
                    reply = self._once(url, data, hdrs, timeout)
            else:
                reply = self._once(url, data, hdrs, timeout)
            if isinstance(reply, str):  # transport failure
                last, wait = reply, 0.0
            else:
                if api:
                    self._note_quota(reply.headers)
                if self._primary_exhausted(reply):  # sleep to the reset; not an attempt
                    wait = max(10.0, int(reply.headers.get("x-ratelimit-reset", 0)) - time.time() + 3)
                    print(f"[quota] {resource} refused; sleeping {int(wait)}s until reset", flush=True)
                    time.sleep(wait)
                    continue
                wait = self._retry_after(reply)
                if wait is None:
                    return reply
                last = f"HTTP {reply.status}"
            attempt += 1
            time.sleep(min(120, wait or 2 ** attempt))  # 0 → exponential backoff
        raise Outcome(f"{url}: gave up after {attempts} attempts ({last})")

    def _once(self, url, data, hdrs, timeout) -> Reply | str:
        req = urllib.request.Request(url, data=data, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return Reply(r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(), r.geturl())
        except urllib.error.HTTPError as e:
            body = e.read() if e.fp else b""
            return Reply(e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, body, url)
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
                http.client.HTTPException, OSError) as e:
            return f"{type(e).__name__}: {e}"

    def _note_quota(self, h: dict) -> None:
        if "x-ratelimit-remaining" in h and "x-ratelimit-reset" in h:
            res = h.get("x-ratelimit-resource", "core")
            with self._lock:
                self.limits[res] = (int(h["x-ratelimit-remaining"]), int(h["x-ratelimit-reset"]))

    def _await_quota(self, resource: str) -> None:
        with self._lock:
            remaining, reset = self.limits.get(resource, (1 << 30, 0))
        wait = reset - time.time() + 3
        if remaining <= 2 and wait > 0:
            print(f"[quota] {resource} exhausted; sleeping {int(wait)}s until reset", flush=True)
            time.sleep(wait)
            with self._lock:
                self.limits.pop(resource, None)

    @staticmethod
    def _primary_exhausted(r: Reply) -> bool:
        return r.status in (403, 429) and r.headers.get("x-ratelimit-remaining") == "0"

    @staticmethod
    def _retry_after(r: Reply) -> float | None:
        """Seconds to wait before retrying this reply, or None when it is final."""
        secondary = r.status == 403 and (b"secondary rate limit" in r.body.lower()
                                         or b"abuse" in r.body.lower() or "retry-after" in r.headers)
        if r.status in RETRY_STATUSES or secondary:
            ra = r.headers.get("retry-after", "")
            return float(ra) if ra.isdigit() else 0.0  # 0 → exponential backoff
        return None


def decode(b: bytes) -> str:
    return b.decode("utf-8", errors="replace")


def expect_ok(r: Reply, what: str) -> Reply:
    if r.status == 200:
        return r
    if r.status in (404, 410):
        raise NotFound(f"{what}: HTTP {r.status}")
    raise Outcome(f"{what}: HTTP {r.status} {decode(r.body[:200]).strip()}")


# ───────────────────────────── what a source yields ─────────────────────────────


@dataclass(frozen=True)
class Entry:
    path: str
    size: int | None  # None where the forge's listing does not say
    executable: bool = False  # the listing's file mode says so (a script with no extension)


@dataclass
class Tree:
    """A source whose files are listed first and read on demand (repos, archives)."""
    listing: list[Entry]
    read: Callable[[str], bytes]
    focused: bool  # its name or description says it is a statusline
    meta: dict
    notes: list[str] = field(default_factory=list)


@dataclass
class Files:
    """A source whose files arrive already read (gists, pages, pastes)."""
    files: list[tuple[str, bytes]]
    meta: dict
    notes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Resolved:
    """This key is another project; `item` is that project, to be read under its own key."""
    item: dict
    meta: dict


# ───────────────────────────── file selection (pure) ─────────────────────────────

CANDIDATE_EXT = {"sh", "bash", "zsh", "fish", "ps1", "js", "mjs", "cjs", "ts", "tsx", "py", "rs",
                 "go", "rb", "lua", "json", "json5", "toml", "yaml", "yml", "jsonc"}
CONFIG_EXT = {"json", "json5", "jsonc", "toml", "yaml", "yml"}
SKIP_DIRS = {"node_modules", "vendor", "dist", "build", "target", ".git", "test", "tests",
             "__tests__", "fixtures", "__fixtures__", ".github"}
LOCKFILES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "poetry.lock",
             "bun.lock", "bun.lockb", "composer.lock", "gemfile.lock", "go.sum", "uv.lock",
             "npm-shrinkwrap.json", "deno.lock", "flake.lock", "pipfile.lock"}
MANIFESTS = {"package.json", "cargo.toml", "go.mod", "pyproject.toml", "requirements.txt"}
SKIP_NAME = re.compile(r"\.min\.|-min\.(js|css)$|\.d\.ts$|\.map$|(^test_|_test\.|\.test\.|\.spec\.|_spec\.)", re.I)
# Keyword groups, best first. Beyond the brief's list: "skin" (a theme by another name), and
# the last group - renderers, glyph/icon tables and constants files are where separators
# and colour codes live (claude-powerline keeps its separators in src/utils/constants.ts).
GROUPS = [re.compile(p, re.I) for p in (
    r"statusline|status[-_]line|statusbar|status[-_]bar|powerline",
    r"theme|skin|palette|colou?r",
    r"style",
    r"segment|hud",
    r"render|glyph|symbol|icon|constants",
)]
STRONG = re.compile(r"statusline|status[-_]line|statusbar|status[-_]bar|powerline|hud", re.I)
# A repo about a statusline, or about Claude Code at all, is in scope whole; a dotfiles-style
# repo is in scope only at its statusline files, however its description reads.
FOCUS = re.compile(r"status[-_ ]?line|status[-_ ]?bar|powerline|(?<![a-z])hud(?![a-z])|claude", re.I)
DOTFILES = re.compile(r"dot-?files|^\.?dots?$|^\.?files$|^\.?config$|nixos|nix-?config|home-?manager", re.I)


def is_focused(name: str, *descs: str | None) -> bool:
    return not DOTFILES.search(name) and any(FOCUS.search(s or "") for s in (name, *descs))


ENTRY_NAMES = re.compile(r"^(src/(main|index)\.[a-z]+|main\.go|src/main\.rs|[^/]+\.(sh|py))$")


def ext_of(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[-1].lower() if "." in base else ""


def is_noise(path: str) -> bool:
    parts = path.split("/")
    return (any(p.lower() in SKIP_DIRS for p in parts[:-1]) or parts[-1].lower() in LOCKFILES
            or bool(SKIP_NAME.search(parts[-1])))


def in_scope(path: str, focused: bool, strong_dirs: set[str]) -> bool:
    """Whether a path can speak for this project's statusline at all.

    A statusline repo is in scope whole. Any other repo (dotfiles, tip collections) is in
    scope only at its statusline files and their directory neighbours, and under a claude dir.
    """
    if focused:
        return True
    d = path.rsplit("/", 1)[0] if "/" in path else ""
    return bool(STRONG.search(path)) or d in strong_dirs or "claude" in path.lower()


def rank_of(e: Entry, focused: bool, strong_dirs: set[str], entries: set[str]) -> tuple | None:
    """Where a file stands in the reading order, or None if it is not a candidate at all.

    Rank: (tier, keyword group, depth, path). Tier 0 is a file named for what it does (or an
    entry point / manifest), 1 a file that only sits in a directory named for it, 2 any other
    source file of an in-scope repo - beyond the brief, so a small repo is read whole.
    """
    p = e.path
    base = p.rsplit("/", 1)[-1]
    depth = p.count("/")
    if p in entries:  # named by the package itself, so a skip directory does not apply
        return (0, 0, depth, p)
    if is_noise(p) or not in_scope(p, focused, strong_dirs):
        return None
    if focused and (depth == 0 and base.lower() in MANIFESTS
                    or ENTRY_NAMES.match(p) and ext_of(p) in CANDIDATE_EXT
                    or e.executable and not ext_of(p) and (depth == 0 or p.startswith("bin/"))):
        return (0, 0, depth, p)
    if ext_of(p) not in CANDIDATE_EXT:
        return None
    own = next((i for i, g in enumerate(GROUPS) if g.search(base)), None)
    if own is not None:
        return (0, own, depth, p)
    via_dir = next((i for i, g in enumerate(GROUPS) if g.search(p)), None)
    if via_dir is not None:
        return (1, via_dir, depth, p)
    return (2, 0, depth, p) if focused and ext_of(p) not in CONFIG_EXT else None


@dataclass(frozen=True)
class Selection:
    chosen: list[str]  # the files to read, best first
    candidates: int  # files matching a keyword, or entry points
    oversize: list[str]  # candidates passed over for the size cap


def select(listing: list[Entry], focused: bool, entries: set[str]) -> Selection:
    strong_dirs = {e.path.rsplit("/", 1)[0] if "/" in e.path else "" for e in listing
                   if STRONG.search(e.path.rsplit("/", 1)[-1])}
    ranked = sorted(((r, e) for e in listing if (r := rank_of(e, focused, strong_dirs, entries))),
                    key=lambda re_: re_[0])
    fits = [r for r, e in ranked if e.size is None or e.size <= MAX_FILE_BYTES]
    return Selection([r[-1] for r in fits[:MAX_FILES]], sum(1 for r in fits if r[0] < 2),
                     [f"{e.path} ({e.size} bytes)" for r, e in ranked if e.size and e.size > MAX_FILE_BYTES])


def package_entries(pkg_json: bytes) -> tuple[set[str], str | None]:
    """package.json's bin and main paths, normalised; or a note saying why there are none."""
    try:
        pkg = json.loads(pkg_json)
    except ValueError as e:
        return set(), f"package.json does not parse: {e}"
    if not isinstance(pkg, dict):
        return set(), "package.json is not an object"
    bins = pkg.get("bin")
    paths = list(bins.values()) if isinstance(bins, dict) else [bins]
    paths.append(pkg.get("main"))
    return {os.path.normpath(p).lstrip("./") for p in paths if isinstance(p, str) and p}, None


def theme_paths(listing: list[Entry], focused: bool) -> list[str]:
    strong_dirs = {e.path.rsplit("/", 1)[0] if "/" in e.path else "" for e in listing
                   if STRONG.search(e.path.rsplit("/", 1)[-1])}
    return [e.path for e in listing
            if not is_noise(e.path) and in_scope(e.path, focused, strong_dirs)
            and (any(c.lower() in ("theme", "themes") for c in e.path.split("/")[:-1])
                 or "theme" in e.path.rsplit("/", 1)[-1].lower())]


NOT_A_THEME = {"index", "mod", "types", "type", "utils", "util", "helpers", "helper", "schema", "readme",
               "__init__", "init", "main", "loader", "registry", "manager", "theme", "themes", "base",
               "constants", "config", "license", ""}


def theme_name_of(path: str) -> str | None:
    parts = path.split("/")
    for i, c in enumerate(parts[:-1]):
        if c.lower() in ("theme", "themes"):
            name = parts[i + 1].rsplit(".", 1)[0] if i + 1 < len(parts) else ""
            return None if name.lower() in NOT_A_THEME else name
    # Only a name the theme word is set off from: dracula-theme.json, theme_nord.toml.
    # PowerlineThemeSelector.tsx names a component, not a theme.
    stem = parts[-1].rsplit(".", 1)[0]
    m = re.fullmatch(r"(?i)([a-z0-9]+(?:[-_][a-z0-9]+)?)[-_.]themes?|themes?[-_.]([a-z0-9]+(?:[-_][a-z0-9]+)?)", stem)
    name = (m.group(1) or m.group(2)) if m else ""
    return None if name.lower() in NOT_A_THEME else name


# ───────────────────────────── signals (pure) ─────────────────────────────
# [LAW:dataflow-not-control-flow] Every rule runs over every file; what differs per rule is
# its pattern, the signals a match means, and the libraries a file must import for the
# match to mean them. Adding a spelling is a row, not a branch.


@dataclass(frozen=True)
class Rule:
    pattern: re.Pattern
    means: Callable[[re.Match, str], Iterable[str]]  # (match, its line up to the match) -> signal names
    gate: frozenset = frozenset()  # libraries one of which the file must import; empty = any file
    via: str = ""  # how the colour was spelled, for color_via


def const(*names: str) -> Callable:
    return lambda m, before: names


NAMED16 = {"black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray", "grey", "purple"}


def depth_of(value: str) -> str | None:
    """'16' | '256' | 'truecolor' for a colour value spelled any common way; None if unknown."""
    v = value.strip().strip("'\"").lower()
    if re.fullmatch(r"#?[0-9a-f]{6}|#[0-9a-f]{3}|rgba?\(.*|truecolor.*|rgb", v):
        return "truecolor"
    m = re.fullmatch(r"(?:colou?r|fixed|ansivalue|ansi256)?\(?(\d{1,3})\)?", v)
    if m:
        return "16" if int(m.group(1)) < 16 else "256" if int(m.group(1)) < 256 else None
    if re.fullmatch(r"colou?r\d{1,3}", v):  # tmux colour208
        return "16" if int(re.sub(r"\D", "", v)) < 16 else "256"
    base = re.sub(r"^(bright|light|dark|hi|on)[-_ ]?|[-_ ]?bright$", "", v)
    if base in NAMED16 or v in ("default", "reset"):
        return "16" if base in NAMED16 else None
    return None


def bucket(side: str, depth: str | None) -> str:
    return f"color.{side}_{depth}" if depth else "color.unclassified"


BG_HINT = re.compile(r"(background|\bbg|on\(|on_|\.on\b|setab|back\.|bgcolor|Back)\W*$", re.I)


def side_of(before: str) -> str:
    return "bg" if BG_HINT.search(before[-24:]) else "fg"


def sgr_means(m: re.Match, before: str) -> list[str]:
    params, nxt = m.group(1), m.group(2)
    if not params and nxt == "m":
        return []  # ESC[m is a reset
    if nxt not in "m" and nxt not in "$%{#+\"'`" and not params.endswith(";"):
        return []  # cursor movement, erase, etc. - not a colour
    toks, out, i = params.split(";"), [], 0
    while i < len(toks):
        t = toks[i]
        if t in ("38", "48"):
            side = "fg" if t == "38" else "bg"
            mode = toks[i + 1] if i + 1 < len(toks) else ""
            out.append(bucket(side, {"5": "256", "2": "truecolor"}.get(mode)))
            i += {"5": 3, "2": 5}.get(mode, 2)
            continue
        if t.isdigit():
            n = int(t)
            if 30 <= n <= 37 or 90 <= n <= 97:
                out.append("color.fg_16")
            elif 40 <= n <= 47 or 100 <= n <= 107:
                out.append("color.bg_16")
        i += 1
    if not out and (nxt != "m" or toks[-1] == ""):
        out.append("color.unclassified")  # parameters filled in at runtime
    return out


def valued(side_group: int | None, value_group: int, fixed_side: str | None = None):
    """Classify a match whose colour value is a group, its side a group, the line, or fixed."""
    def means(m: re.Match, before: str):
        side = fixed_side or (("bg" if m.group(side_group) else "fg") if side_group else side_of(before))
        return [bucket(side, depth_of(m.group(value_group)))]
    return means


def rich_tokens(spec: str) -> list[str]:
    """Signals a rich style string ('bold red on #112233') means; [] if it is not one."""
    words = spec.replace(",", " ").split()
    attrs = {"bold", "dim", "italic", "underline", "reverse", "blink", "strike", "not", "b", "i", "u",
             "s", "link", "conceal", "overline", "frame", "encircle"}
    out, side = [], "fg"
    for w in words:
        if w == "on":
            side = "bg"
            continue
        if w in attrs or w.startswith("link="):
            continue
        d = depth_of(w)
        if d is None and re.fullmatch(r"[a-z]+(?:_[a-z]+)*\d*", w) and re.search(
                r"\d$|_|orange|pink|violet|gold|grey|gray|navy|teal|purple|olive|salmon|plum|orchid|tan|khaki", w):
            d = "256"  # rich's named 256-colour palette (dark_orange3, grey50, ...)
        if d is None:
            return []  # some word is no style word: this is not a style string
        out.append(bucket(side, d))
        side = "fg"
    return out


def rich_means(m: re.Match, before: str):
    return rich_tokens(m.group(1).strip().lower())


def js_lib(pkg: str) -> str:
    q = re.escape(pkg)
    return rf"""(?:require\(\s*|from\s+|import\s+|import\(\s*)['"]{q}(?:/[\w/-]*)?['"]|"{q}"\s*:\s*"[~^<>=\d*]"""


def py_lib(mod: str) -> str:
    q = re.escape(mod)
    return rf"(?m)^\s*(?:import|from)\s+{q}\b|^{q}\s*(?:[<>=~!\[;]|$)|[\"']{q}\s*[<>=~\[\"']"


def rs_lib(crate: str) -> str:
    ident = re.escape(crate.replace("-", "_"))
    return rf"(?m)\buse\s+{ident}\b|\b{ident}::|^\s*{re.escape(crate)}\s*="


def go_lib(module: str) -> str:
    return rf"{re.escape(module)}(?:/v\d+)?(?:\"|\s+v\d)"


LIBS = {
    # JS
    "chalk": js_lib("chalk"), "picocolors": js_lib("picocolors"), "kleur": js_lib("kleur"),
    "colorette": js_lib("colorette"), "ansi-styles": js_lib("ansi-styles"), "ansi-colors": js_lib("ansi-colors"),
    "colors": js_lib("colors"), "cli-color": js_lib("cli-color"), "ink": js_lib("ink"),
    "gradient-string": js_lib("gradient-string"),
    # Python
    "rich": py_lib("rich"), "colorama": py_lib("colorama"), "termcolor": py_lib("termcolor"),
    "blessed": py_lib("blessed"),
    # Rust
    "owo-colors": rs_lib("owo-colors"), "colored": rs_lib("colored"), "ansi_term": rs_lib("ansi_term"),
    "nu-ansi-term": rs_lib("nu-ansi-term"), "crossterm": rs_lib("crossterm"), "yansi": rs_lib("yansi"),
    "ratatui": rs_lib("ratatui"),
    # Go
    "lipgloss": go_lib("github.com/charmbracelet/lipgloss"), "fatih/color": go_lib("github.com/fatih/color"),
    "termenv": go_lib("github.com/muesli/termenv"), "gookit/color": go_lib("github.com/gookit/color"),
}
LIB_PATTERNS = {name: re.compile(p) for name, p in LIBS.items()}

JS_COLOR = frozenset({"chalk", "picocolors", "kleur", "colorette", "ansi-styles", "ansi-colors", "colors", "cli-color"})
RUST_METHODS = frozenset({"owo-colors", "colored", "yansi"})
RUST_ENUMS = frozenset({"ansi_term", "nu-ansi-term", "crossterm", "ratatui"})
C16 = "black|red|green|yellow|blue|magenta|cyan|white|gray|grey"
C16_CAP = "Black|Red|Green|Yellow|Blue|Magenta|Cyan|White|Gray|Grey"

ESC = (r"(?:\\033|\\0?33(?=\[)|\\e|\\E|\\x1[bB]|\\u001[bB]|\\u\{1[bB]\}|\\x\{1[bB]\}|\\27|\x1b"
       r"|\\U0000001[bB]|(?:\$\{|\$|\{)(?:ESC|esc|ESCAPE|E)\}?)")


def rx(p: str, flags=0) -> re.Pattern:
    return re.compile(p, flags)


COLOR_RULES = [
    Rule(rx(ESC + r"\[([0-9;]*)(.?)"), sgr_means, via="escape"),
    Rule(rx(r"\btput\s+(setaf|setab)\s+(\S+)"),
         lambda m, b: [bucket("fg" if m.group(1) == "setaf" else "bg",
                              depth_of(m.group(2)) if m.group(2).isdigit() else None)], via="tput"),
    Rule(rx(r"%([FK])\{([^}]+)\}"),
         lambda m, b: [bucket("fg" if m.group(1) == "F" else "bg", depth_of(m.group(2)))], via="zsh-prompt"),
    Rule(rx(r"#\[[^\]]*?\b(fg|bg)=([#\w]+)"), lambda m, b: [bucket(m.group(1), depth_of(m.group(2)))], via="tmux"),
    # JS: chalk / picocolors / kleur / colorette / ansi-styles
    Rule(rx(rf"(?:(?<=\.)|(?<![\w$.]))(?:bg({C16_CAP})|({C16}))(?:Bright)?(?=[.(`\s,)])"),
         lambda m, b: ["color.bg_16" if m.group(1) else "color.fg_16"], JS_COLOR, "js-lib"),
    Rule(rx(r"\.(bgHex|bgRgb|hex|rgb)\("), lambda m, b: [bucket("bg" if m.group(1).startswith("bg") else "fg", "truecolor")],
         JS_COLOR, "js-lib"),
    Rule(rx(r"\.(bgAnsi256|ansi256)\("), lambda m, b: [bucket("bg" if m.group(1).startswith("bg") else "fg", "256")],
         JS_COLOR, "js-lib"),
    Rule(rx(r"\b(color|backgroundColor)=\{?[\"'`]([^\"'`]+)"),
         lambda m, b: [bucket("bg" if m.group(1) == "backgroundColor" else "fg", depth_of(m.group(2)))],
         frozenset({"ink"}), "ink"),
    # Python
    Rule(rx(r"\[(?!/)([a-z#][a-z0-9_#(), ]*?)\]"), rich_means, frozenset({"rich"}), "rich-markup"),
    Rule(rx(r"\bstyle\s*=\s*[\"']([^\"']+)[\"']"), rich_means, frozenset({"rich"}), "rich-style"),
    Rule(rx(r"\b(bg)?color\s*=\s*[\"']([^\"']+)[\"']"), valued(1, 2), frozenset({"rich"}), "rich-style"),
    Rule(rx(r"\b(Fore|Back)\.(\w+)"), lambda m, b: ["color.bg_16" if m.group(1) == "Back" else "color.fg_16"],
         frozenset({"colorama"}), "colorama"),
    Rule(rx(r"[\"'](on_)?(" + C16 + r"|light_\w+|dark_\w+)[\"']"),
         lambda m, b: ["color.bg_16" if m.group(1) else "color.fg_16"], frozenset({"termcolor"}), "termcolor"),
    # Rust
    Rule(rx(r"\.(on_)?(black|red|green|yellow|blue|magenta|purple|cyan|white|bright_\w+)\(\)"),
         lambda m, b: ["color.bg_16" if m.group(1) else "color.fg_16"], RUST_METHODS, "rust-lib"),
    Rule(rx(r"\.(on_)?(truecolor|custom_color|fg_rgb|bg_rgb|rgb)\b"),
         lambda m, b: [bucket("bg" if m.group(1) or m.group(2) == "bg_rgb" else "fg", "truecolor")],
         RUST_METHODS, "rust-lib"),
    Rule(rx(r"\.(on_)?(color|fixed|fg_fixed|bg_fixed)\("),
         lambda m, b: [bucket("bg" if m.group(1) else "fg", "256" if "fixed" in m.group(2) else None)],
         RUST_METHODS, "rust-lib"),
    Rule(rx(r"\bColou?r::(\w+)"),
         lambda m, b: [] if m.group(1) in ("Reset", "Default") else [bucket(
             side_of(b), "256" if m.group(1) in ("Fixed", "AnsiValue", "Indexed")
             else "truecolor" if m.group(1) in ("Rgb", "RGB") else "16")], RUST_ENUMS, "rust-lib"),
    # Go
    Rule(rx(r"\b(?:lipgloss|termenv)\.Colou?r\(\s*\"([^\"]*)\""), lambda m, b: [bucket(side_of(b), depth_of(m.group(1)))],
         frozenset({"lipgloss", "termenv"}), "go-lib"),
    Rule(rx(r"\bcolor\.(Fg|Bg)(Hi)?[A-Z]\w*"), lambda m, b: ["color.bg_16" if m.group(1) == "Bg" else "color.fg_16"],
         frozenset({"fatih/color"}), "go-lib"),
    Rule(rx(r"\b(?:color\.|\.Add)(RGB|BgRGB)\("), lambda m, b: [bucket("bg" if m.group(1) == "BgRGB" else "fg", "truecolor")],
         frozenset({"fatih/color"}), "go-lib"),
    Rule(rx(r"\.(RGBColor|ANSI256Color|ANSIColor)\("),
         lambda m, b: [bucket(side_of(b), {"RGBColor": "truecolor", "ANSI256Color": "256"}.get(m.group(1), "16"))],
         frozenset({"termenv"}), "go-lib"),
]

NAMED_THEMES = {
    "dracula": r"dracula", "nord": r"\bnord\b", "gruvbox": r"gruvbox", "catppuccin": r"catppuccin|\bmocha\b|\bmacchiato\b|\bfrapp[eé]\b",
    "solarized": r"solarized", "tokyo-night": r"tokyo[-_ ]?night", "one-dark": r"\bone[-_ ]?dark\b|\bonedark\b",
    "monokai": r"monokai", "rose-pine": r"ros[eé][-_ ]?pine", "everforest": r"everforest", "kanagawa": r"kanagawa",
    "ayu": r"\bayu\b", "nightfox": r"nightfox", "palenight": r"palenight", "synthwave": r"synthwave",
    "cyberpunk": r"cyberpunk", "material": r"\bmaterial[-_ ]?(?:theme|dark|ocean|palenight)\b", "night-owl": r"night[-_ ]?owl",
    "tomorrow-night": r"tomorrow[-_ ]?night", "zenburn": r"zenburn", "iceberg": r"\biceberg\b", "poimandres": r"poimandres",
    "github": r"github[-_ ]?(?:dark|light)", "vesper": r"\bvesper\b", "oceanic": r"oceanic", "horizon": r"\bhorizon[-_ ]?(?:dark|theme)\b",
}
NAMED_THEME_RX = [(name, re.compile(p, re.I)) for name, p in NAMED_THEMES.items()]

PLAIN_RULES = [
    Rule(rx(r"(?<![\w&/])#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?(?![0-9a-zA-Z])|[\"']#[0-9a-fA-F]{3}[\"']"), const("hex_colors")),
    Rule(rx(r"(?i)[\"']?\b(?:fg|bg|colou?r|background|foreground)[\"']?\s*[:=]\s*[\"'`][^\"'`\n]{1,40}[\"'`]"),
         const("named_color_keys")),
    Rule(rx(r"(?i)[\"']?\btheme[\"']?\s*(?:=(?!=)|:(?!\s*(?:string|number|boolean|any|unknown|[A-Z]\w*)\b))|--theme\b"),
         const("theme.key")),  # a key with a value, not a TypeScript annotation (theme: string)
    Rule(rx(r"\bNO_COLOR\b"), const("env.NO_COLOR")),
    Rule(rx(r"\bFORCE_COLOR\b"), const("env.FORCE_COLOR")),
    Rule(rx(r"\bCOLORTERM\b"), const("env.COLORTERM")),
    Rule(rx(r"(?i)truecolou?r|24[-_ ]?bit"), const("env.truecolor")),
    Rule(rx(r"(?i)256[-_ ]?colou?rs?"), const("env.256color")),
    Rule(rx(r"\]11;\?"), const("lightdark.osc11")),
    Rule(rx(r"\bCOLORFGBG\b"), const("lightdark.COLORFGBG")),
    Rule(rx(r"AppleInterfaceStyle|AdaptiveColor|HasDarkBackground|prefers-color-scheme|terminal-light|\btermbg\b"
            r"|(?i:detect\w*(?:dark|light|background))|\bis_?[Dd]ark\b"), const("lightdark.detection")),
    Rule(rx(r"(?i)\b(?:light|dark)[-_ ]?(?:theme|mode|variant|background)\b|theme\W{1,4}(?:light|dark)\b"),
         const("lightdark.words")),
    Rule(rx(r"(?i)gradient|\blerp\b|interpolat\w*"), const("motion.gradient")),
    Rule(rx(r"(?i)rainbow"), const("motion.rainbow")),
    Rule(rx(r"(?i)animat\w*|spinner|shimmer|marquee|\bblink\b"), const("motion.animation")),
]

CLAUDE_FIELDS = {
    "context_window": r"\bcontext_window\b", "workspace": r"\.workspace\b|[\"']workspace[\"']",
    "current_dir": r"\bcurrent_dir\b", "display_name": r"\bdisplay_name\b", "total_cost_usd": r"\btotal_cost_usd\b",
    "transcript_path": r"\btranscript_path\b", "session_id": r"\bsession_id\b", "rate_limits": r"\brate_limits\b",
    "exceeds_200k_tokens": r"\bexceeds_200k_tokens\b",
}
CLAUDE_RX = {k: re.compile(p) for k, p in CLAUDE_FIELDS.items()}
STATUSLINE_SETTING = re.compile(r"[\"']?\bstatusLine\b[\"']?\s*[:=]|\"statusLine\"")

GLYPH_CHAR = re.compile("[\u2500-\u259f\u2600-\u27bf\u2800-\u28ff\u2b50\u2b55\ue000-\uf8ff"
                        "\U0001F000-\U0001FAFF\U000F0000-\U0010FFFD]")
GLYPH_ESCAPE = re.compile(r"\\u\{([0-9a-fA-F]{4,6})\}|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|\\x\{([0-9a-fA-F]{4,6})\}"
                          r"|((?:\\x[eEfF][0-9a-fA-F])(?:\\x[89abAB][0-9a-fA-F]){2,3})"
                          r"|((?:\\3[4-7][0-7])(?:\\2[0-7][0-7]){2,3})")


def glyph_class(cp: int) -> str | None:
    if 0xE0B0 <= cp <= 0xE0BF:
        return "glyph.powerline"
    if 0xE000 <= cp <= 0xF8FF or cp >= 0xF0000:
        return "glyph.nerd_font"
    if 0x1F000 <= cp <= 0x1FAFF or 0x2600 <= cp <= 0x27BF or cp in (0x2B50, 0x2B55):
        return "glyph.emoji"
    if 0x2500 <= cp <= 0x259F or 0x2800 <= cp <= 0x28FF:
        return "glyph.box"
    return None


def escaped_cp(m: re.Match) -> int | None:
    hexes = m.group(1) or m.group(2) or m.group(3) or m.group(4)
    if hexes:
        return int(hexes, 16)
    raw = m.group(5) or m.group(6)
    try:
        data = bytes(int(h, 16) for h in raw.split("\\x")[1:]) if m.group(5) else \
            bytes(int(o, 8) for o in raw.split("\\")[1:])
        return ord(data.decode("utf-8")[0])
    except (ValueError, UnicodeDecodeError, IndexError):
        return None


class Tally:
    """Counts and up-to-3 distinct sample lines per signal, plus how colours were spelled."""

    def __init__(self):
        self.counts: Counter = Counter()
        self.samples: dict[str, list[str]] = defaultdict(list)
        self.via: Counter = Counter()

    def hit(self, name: str, sample: str) -> None:
        self.counts[name] += 1
        s = self.samples[name]
        if len(s) < SAMPLES and sample not in s:
            s.append(sample)

    def result(self) -> dict:
        return {k: {"count": n, "samples": self.samples[k]} for k, n in sorted(self.counts.items())}


@dataclass(frozen=True)
class Text:
    path: str
    body: str
    starts: list[int]  # offset of each line

    @staticmethod
    def of(path: str, body: str) -> "Text":
        return Text(path, body, [0] + [m.end() for m in re.finditer("\n", body)])

    def where(self, offset: int) -> tuple[str, str]:
        """(sample 'path:line: text', the line's text before `offset`)."""
        i = bisect.bisect_right(self.starts, offset) - 1
        start = self.starts[i]
        end = self.body.find("\n", start)
        line = self.body[start:end if end >= 0 else len(self.body)]
        return f"{self.path}:{i + 1}: {line.strip()[:SAMPLE_CHARS]}", self.body[start:offset]


def analyze(texts: list[Text]) -> tuple[dict, dict, dict]:
    """(claude_evidence, signals, themes-from-content) for the files read."""
    tally = Tally()
    claude: Counter = Counter()
    setting = False
    named: set[str] = set()
    for t in texts:
        libs = {name for name, p in LIB_PATTERNS.items() if p.search(t.body)}
        for name in libs:
            for m in LIB_PATTERNS[name].finditer(t.body):
                tally.hit(f"lib.{name}", t.where(m.start())[0])
        for rule in COLOR_RULES:
            if rule.gate and not (rule.gate & libs):
                continue
            for m in rule.pattern.finditer(t.body):
                sample, before = t.where(m.start())
                for name in rule.means(m, before):
                    tally.hit(name, sample)
                    tally.via[rule.via] += 1
        for rule in PLAIN_RULES:
            for m in rule.pattern.finditer(t.body):
                for name in rule.means(m, ""):
                    tally.hit(name, t.where(m.start())[0])
        for m in GLYPH_CHAR.finditer(t.body):
            name = glyph_class(ord(m.group()))
            if name:
                tally.hit(name, t.where(m.start())[0])
        for m in GLYPH_ESCAPE.finditer(t.body):
            cp = escaped_cp(m)
            name = glyph_class(cp) if cp is not None else None
            if name:
                tally.hit(name, t.where(m.start())[0])
        for k, p in CLAUDE_RX.items():
            claude[k] += len(p.findall(t.body))
        setting = setting or bool(STATUSLINE_SETTING.search(t.body))
        named |= {name for name, p in NAMED_THEME_RX if p.search(t.body)}
    signals = tally.result()
    signals["color_via"] = dict(tally.via)
    evidence = {"fields": sorted(k for k, n in claude.items() if n), "statusLine_setting": setting,
                "field_hits": sum(claude.values())}
    return evidence, signals, {"named_in_content": sorted(named)}


# ───────────────────────────── sources ─────────────────────────────

GH_REPO = re.compile(r"github\.com[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?(?:[/#?]|$)", re.I)


def github_item(owner: str, repo: str, via: str) -> dict:
    return {"key": f"github.com/{owner}/{repo}".lower(), "url": f"https://github.com/{owner}/{repo}",
            "desc": None, "via": via}


def github_ref(text: str | None) -> tuple[str, str] | None:
    m = GH_REPO.search(text or "")
    if not m or m.group(1).lower() in ("sponsors", "orgs", "features", "topics"):
        return None
    return m.group(1), m.group(2)


GQL_FIELDS = ("nameWithOwner stargazerCount isFork isArchived isEmpty pushedAt description "
              "primaryLanguage{name} parent{nameWithOwner} defaultBranchRef{name target{oid}}")


def github_meta(http: Http, refs: list[tuple[str, str]]) -> dict[tuple[str, str], dict | Outcome]:
    """GraphQL metadata for up to 100 repos in one query: a dict per repo, or its Outcome."""
    parts = [f"r{i}: repository(owner: {json.dumps(o)}, name: {json.dumps(n)}) {{ {GQL_FIELDS} }}"
             for i, (o, n) in enumerate(refs)]
    query = "query { " + " ".join(parts) + " }"
    reply = http.get("https://api.github.com/graphql", data=json.dumps({"query": query}).encode(),
                     headers={"Content-Type": "application/json"})
    if reply.status != 200:
        failure = Outcome(f"graphql HTTP {reply.status}: {decode(reply.body[:200])}")
        return {r: failure for r in refs}
    doc = reply.json()
    data = doc.get("data") or {}
    errors = {e["path"][0]: e for e in doc.get("errors", []) if e.get("path")}
    out: dict = {}
    for i, ref in enumerate(refs):
        alias = f"r{i}"
        if data.get(alias):
            out[ref] = data[alias]
        elif alias in errors:
            e = errors[alias]
            out[ref] = NotFound(e["message"]) if e.get("type") == "NOT_FOUND" else Outcome(f"graphql: {e['message']}")
        else:
            out[ref] = Outcome(f"graphql returned nothing for this repo: {json.dumps(doc.get('errors'))[:200]}")
    return out


def github_source(http: Http, item: dict, meta: dict | Outcome, input_keys: set[str]) -> Tree | Resolved:
    if isinstance(meta, Outcome):
        raise meta
    nwo = meta["nameWithOwner"]
    record = {"stars": meta["stargazerCount"], "fork": meta["isFork"], "archived": meta["isArchived"],
              "language": (meta.get("primaryLanguage") or {}).get("name"), "pushed_at": meta["pushedAt"],
              "default_branch": (meta.get("defaultBranchRef") or {}).get("name"), "name_with_owner": nwo,
              "fork_of": (meta.get("parent") or {}).get("nameWithOwner"), "description": meta.get("description")}
    canonical = f"github.com/{nwo}".lower()
    if canonical != item["key"] and canonical in input_keys:  # a rename; the new name is in the list
        return Resolved({"key": canonical, "url": f"https://github.com/{nwo}", "desc": None}, record)
    if meta["isEmpty"] or not meta.get("defaultBranchRef"):
        raise Empty("repository has no commits")
    sha = meta["defaultBranchRef"]["target"]["oid"]
    r = http.get(f"https://api.github.com/repos/{nwo}/git/trees/{sha}?recursive=1")
    if r.status == 409:
        raise Empty("git tree: HTTP 409 (empty repository)")
    tree = expect_ok(r, "git tree").json()
    listing = [Entry(e["path"], e.get("size"), e.get("mode") == "100755") for e in tree["tree"]
               if e["type"] == "blob" and e.get("mode") != "120000"]
    notes = ["tree truncated by GitHub (over 100k entries); listing is partial"] if tree.get("truncated") else []

    def read(path: str) -> bytes:
        url = f"https://raw.githubusercontent.com/{nwo}/{sha}/{urllib.parse.quote(path)}"
        return expect_ok(http.get(url), f"raw {path}").body

    focused = is_focused(nwo.split("/")[1], item.get("desc"), meta.get("description"))
    return Tree(listing, read, focused, record, notes)


def gist_source(http: Http, item: dict) -> Files:
    gid = item["key"].split("/", 1)[1]
    doc = expect_ok(http.get(f"https://api.github.com/gists/{gid}"), "gist").json()
    files, notes = [], []
    for name, f in list(doc.get("files", {}).items()):
        if len(files) >= MAX_FILES:
            notes.append(f"more than {MAX_FILES} files; read the first {MAX_FILES}")
            break
        if (f.get("size") or 0) > MAX_FILE_BYTES:
            notes.append(f"{name}: {f.get('size')} bytes, over the {MAX_FILE_BYTES} cap; not read")
            continue
        body = f.get("content")
        if f.get("truncated") or body is None:
            body = decode(expect_ok(http.get(f["raw_url"]), f"gist raw {name}").body)
        files.append((name, body.encode()))
    meta = {"owner": (doc.get("owner") or {}).get("login"), "updated_at": doc.get("updated_at"),
            "description": doc.get("description"), "file_count": len(doc.get("files", {}))}
    if not doc.get("files"):
        raise Empty("gist has no files")
    return Files(files, meta, notes)


def project_path(item: dict) -> str:
    """owner/…/repo from the item's URL, without a forge's /-/ or /src/ suffix."""
    path = urllib.parse.urlsplit(item["url"]).path.strip("/")
    return re.split(r"/-/|/(?:src|tree|blob|raw)/", path)[0].removesuffix(".git")


def gitlab_source(http: Http, item: dict) -> Tree | Files:
    path = project_path(item)
    if path.startswith("-/snippets") or "/snippets" in path or path.startswith("users/"):
        return raw_page(http, item, item["url"].rstrip("/") + "/raw") if re.search(r"snippets/\d+", item["url"]) \
            else page_source(http, item)
    api = f"https://gitlab.com/api/v4/projects/{urllib.parse.quote(path, safe='')}"
    p = expect_ok(http.get(api), "gitlab project").json()
    meta = {"stars": p.get("star_count"), "fork": bool(p.get("forked_from_project")), "archived": p.get("archived"),
            "pushed_at": p.get("last_activity_at"), "default_branch": p.get("default_branch"),
            "name_with_owner": p.get("path_with_namespace"), "description": p.get("description")}
    if p.get("empty_repo") or not p.get("default_branch"):
        raise Empty("gitlab project has no commits")
    branch = p["default_branch"]
    listing, url = [], f"{api}/repository/tree?recursive=true&per_page=100&pagination=keyset&ref={urllib.parse.quote(branch)}"
    while url:
        r = expect_ok(http.get(url), "gitlab tree")
        listing += [Entry(e["path"], None, e.get("mode") == "100755") for e in r.json() if e["type"] == "blob"]
        nxt = re.search(r'<([^>]+)>;\s*rel="next"', r.headers.get("link", ""))
        url = nxt.group(1) if nxt else None

    def read(fp: str) -> bytes:
        return expect_ok(http.get(f"{api}/repository/files/{urllib.parse.quote(fp, safe='')}/raw?ref="
                                  f"{urllib.parse.quote(branch)}"), f"gitlab raw {fp}").body

    focused = is_focused(path.rsplit("/", 1)[-1], item.get("desc"), p.get("description"))
    return Tree(listing, read, focused, meta)


def gitea_source(http: Http, item: dict) -> Tree:
    host = urllib.parse.urlsplit(item["url"]).hostname
    path = project_path(item)
    api = f"https://{host}/api/v1/repos/{path}"
    p = expect_ok(http.get(api), "gitea repo").json()
    meta = {"stars": p.get("stars_count"), "fork": p.get("fork"), "archived": p.get("archived"),
            "pushed_at": p.get("updated_at"), "default_branch": p.get("default_branch"),
            "language": p.get("language"), "name_with_owner": p.get("full_name"), "description": p.get("description")}
    if p.get("empty") or not p.get("default_branch"):
        raise Empty("gitea repository has no commits")
    branch = urllib.parse.quote(p["default_branch"])
    listing, page, notes = [], 1, []
    while True:
        t = expect_ok(http.get(f"{api}/git/trees/{branch}?recursive=true&per_page=1000&page={page}"), "gitea tree").json()
        listing += [Entry(e["path"], e.get("size"), e.get("mode") == "100755")
                    for e in t.get("tree") or [] if e["type"] == "blob"]
        if not t.get("truncated") or not t.get("tree"):
            break
        page += 1

    def read(fp: str) -> bytes:
        return expect_ok(http.get(f"https://{host}/{path}/raw/branch/{branch}/{urllib.parse.quote(fp)}"), f"raw {fp}").body

    focused = is_focused(path.rsplit("/", 1)[-1], item.get("desc"), p.get("description"))
    return Tree(listing, read, focused, meta, notes)


def archive_tree(blob: bytes, focused: bool, meta: dict) -> Tree:
    """A Tree over an in-memory .tgz / .tar.gz / .crate / .zip / .whl / .vsix."""
    if blob[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(blob))
        members = {i.filename: (i.file_size, bool((i.external_attr >> 16) & 0o111))
                   for i in z.infolist() if not i.is_dir()}
        reader = z.read
    else:
        t = tarfile.open(fileobj=io.BytesIO(blob), mode="r:*")
        infos = {i.name: i for i in t.getmembers() if i.isfile()}
        members = {n: (i.size, bool(i.mode & 0o111)) for n, i in infos.items()}
        reader = lambda n: t.extractfile(infos[n]).read()
    tops = {n.split("/", 1)[0] for n in members}
    prefix = next(iter(tops)) + "/" if len(tops) == 1 and all("/" in n for n in members) else ""
    listing = [Entry(n[len(prefix):], size, x) for n, (size, x) in members.items()]
    lock = threading.Lock()  # zipfile/tarfile objects are not safe to read from two threads

    def read(path: str) -> bytes:
        with lock:
            return reader(prefix + path)

    return Tree(listing, read, focused, meta)


def download(http: Http, url: str, what: str) -> bytes:
    body = expect_ok(http.get(url), what).body
    if len(body) > MAX_ARCHIVE_BYTES:
        raise Outcome(f"{what}: {len(body)} bytes, over the {MAX_ARCHIVE_BYTES} cap")
    return body


def npm_source(http: Http, item: dict) -> Tree | Resolved:
    name = item["key"].split("/package/", 1)[1]
    doc = expect_ok(http.get("https://registry.npmjs.org/" + name.replace("/", "%2f")), "npm registry").json()
    repo = doc.get("repository")
    repo_url = repo.get("url") if isinstance(repo, dict) else repo
    latest = (doc.get("dist-tags") or {}).get("latest")
    meta = {"package": name, "latest": latest, "repository": repo_url, "description": doc.get("description"),
            "modified": (doc.get("time") or {}).get("modified")}
    ref = github_ref(repo_url if isinstance(repo_url, str) else None)
    if ref:
        return Resolved(github_item(*ref, via=item["key"]), meta)
    if not latest:
        raise Empty("npm package has no published version")
    tarball = doc["versions"][latest]["dist"]["tarball"]
    focused = is_focused(name, doc.get("description"), item.get("desc"))
    return archive_tree(download(http, tarball, "npm tarball"), focused, meta)


def pypi_source(http: Http, item: dict) -> Tree | Resolved:
    name = item["key"].split("/project/", 1)[1].strip("/")
    doc = expect_ok(http.get(f"https://pypi.org/pypi/{name}/json"), "pypi").json()
    info = doc["info"]
    meta = {"package": name, "latest": info.get("version"), "description": info.get("summary")}
    for u in [*(info.get("project_urls") or {}).values(), info.get("home_page")]:
        ref = github_ref(u)
        if ref:
            return Resolved(github_item(*ref, via=item["key"]), meta)
    dists = sorted(doc.get("urls") or [], key=lambda d: d["packagetype"] != "sdist")
    if not dists:
        raise Empty("pypi project has no distribution files")
    focused = is_focused(name, info.get("summary"), item.get("desc"))
    return archive_tree(download(http, dists[0]["url"], "pypi distribution"), focused, meta)


def crates_source(http: Http, item: dict) -> Tree | Resolved:
    name = item["key"].split("/crates/", 1)[1].strip("/")
    c = expect_ok(http.get(f"https://crates.io/api/v1/crates/{name}"), "crates.io").json()["crate"]
    meta = {"package": name, "latest": c.get("max_version"), "repository": c.get("repository"),
            "description": c.get("description")}
    ref = github_ref(c.get("repository"))
    if ref:
        return Resolved(github_item(*ref, via=item["key"]), meta)
    url = f"https://static.crates.io/crates/{name}/{name}-{c['max_version']}.crate"
    focused = is_focused(name, c.get("description"), item.get("desc"))
    return archive_tree(download(http, url, "crate"), focused, meta)


def openvsx_source(http: Http, item: dict) -> Tree | Resolved:
    ns, name = item["key"].split("/extension/", 1)[1].split("/")[:2]
    d = expect_ok(http.get(f"https://open-vsx.org/api/{ns}/{name}"), "open-vsx").json()
    meta = {"package": f"{ns}.{name}", "latest": d.get("version"), "repository": d.get("repository"),
            "description": d.get("description")}
    ref = github_ref(d.get("repository"))
    if ref:
        return Resolved(github_item(*ref, via=item["key"]), meta)
    url = (d.get("files") or {}).get("download")
    if not url:
        raise Empty("open-vsx extension has no download")
    return archive_tree(download(http, url, "vsix"), True, meta)


class CodeBlocks(html.parser.HTMLParser):
    """The text of every outermost <pre> or <code> element, in page order."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self.title = ""
        self._depth = 0
        self._buf: list[str] = []
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in ("pre", "code"):
            self._depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag == "br" and self._depth:
            self._buf.append("\n")

    def handle_endtag(self, tag):
        if tag in ("pre", "code") and self._depth:
            self._depth -= 1
            if not self._depth:
                text = "".join(self._buf)
                if text.strip():
                    self.blocks.append(text)
                self._buf = []
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._depth:
            self._buf.append(data)
        elif self._in_title:
            self.title += data


SKIP_HOSTS = {"x.com", "twitter.com", "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"}


def fetch_page(http: Http, url: str) -> Reply:
    r = expect_ok(http.get(url, headers={"Accept": "text/html,text/plain;q=0.9,*/*;q=0.5"}), "page")
    if len(r.body) > MAX_PAGE_BYTES:
        raise Outcome(f"page: {len(r.body)} bytes, over the {MAX_PAGE_BYTES} cap")
    return r


def page_source(http: Http, item: dict) -> Files:
    host = urllib.parse.urlsplit(item["url"]).hostname or ""
    if host in SKIP_HOSTS:
        raise Skipped(f"{host}: no fetchable code on the page")
    r = fetch_page(http, item["url"])
    ctype = r.headers.get("content-type", "")
    meta = {"final_url": r.url, "content_type": ctype}
    if "html" not in ctype:
        return Files([("page", r.body)], meta)
    parser = CodeBlocks()
    parser.feed(r.text())
    meta["title"] = html.unescape(parser.title.strip())[:200]
    meta["code_blocks"] = len(parser.blocks)
    if not parser.blocks:
        raise NoCandidates("page has no <pre> or <code> blocks")
    # Every block is one 'file'; they are read whole, so the 20-file cap does not apply here.
    return Files([(f"block[{i + 1}]", b.encode()) for i, b in enumerate(parser.blocks)], meta)


def raw_page(http: Http, item: dict, raw_url: str) -> Files:
    r = fetch_page(http, raw_url)
    if not r.body.strip():
        raise Empty("raw text is empty")
    return Files([("raw", r.body)], {"final_url": r.url, "content_type": r.headers.get("content-type", "")})


def pastebin_source(http: Http, item: dict) -> Files:
    pid = urllib.parse.urlsplit(item["url"]).path.strip("/").split("/")[-1]
    return raw_page(http, item, f"https://pastebin.com/raw/{pid}")


def gopkg_source(http: Http, item: dict) -> Resolved | Files:
    ref = github_ref(item["key"])
    if ref:
        return Resolved(github_item(*ref, via=item["key"]), {"module": item["key"].split("/", 1)[1]})
    return page_source(http, item)


# [LAW:dataflow-not-control-flow] Which reader a key gets is one lookup on its first segment.
SOURCES: dict[str, Callable] = {
    "gist": gist_source, "gitlab.com": gitlab_source, "codeberg.org": gitea_source,
    "gitea.kajkowalski.nl": gitea_source, "npmjs.com": npm_source, "pypi.org": pypi_source,
    "crates.io": crates_source, "open-vsx.org": openvsx_source, "pastebin.com": pastebin_source,
    "pkg.go.dev": gopkg_source,
}


# ───────────────────────────── one project ─────────────────────────────


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def read_tree(tree: Tree) -> tuple[list[tuple[str, bytes]], dict]:
    """Choose and read a Tree's files; returns them and the record fields the choice made."""
    cache: dict[str, bytes] = {}
    errors: list[str] = []
    entries: set[str] = set()
    paths = {e.path for e in tree.listing}
    if tree.focused and "package.json" in paths:
        try:
            cache["package.json"] = tree.read("package.json")
            entries, note = package_entries(cache["package.json"])
            entries &= paths
            if note:
                tree.notes.append(note)
        except Outcome as e:
            errors.append(f"package.json: {e}")
    sel = select(tree.listing, tree.focused, entries)
    files = []
    for p in sel.chosen:
        try:
            data = cache[p] if p in cache else tree.read(p)
        except Outcome as e:
            errors.append(f"{p}: {e}")
            continue
        if len(data) > MAX_FILE_BYTES:
            tree.notes.append(f"{p}: {len(data)} bytes, over the {MAX_FILE_BYTES} cap; not analysed")
            continue
        files.append((p, data))
    tpaths = theme_paths(tree.listing, tree.focused)
    extra = {"candidates": sel.candidates, "tree_files": len(tree.listing), "focused": tree.focused,
             "file_errors": errors, "oversize": sel.oversize[:SAMPLES * 3],
             "theme_paths": {"count": len(tpaths), "samples": tpaths[:SAMPLES]},
             "theme_names_from_paths": sorted({n for n in map(theme_name_of, tpaths) if n})[:60]}
    if not sel.chosen:
        over = f"; over the {MAX_FILE_BYTES}-byte cap: {', '.join(sel.oversize[:5])}" if sel.oversize else ""
        raise NoCandidates(f"{len(tree.listing)} files listed, none selected{over}")
    if not files:
        raise Outcome(f"every selected file failed to read: {'; '.join(errors)[:300]}")
    return files, extra


def process(http: Http, item: dict, meta, input_keys: set[str]) -> tuple[dict, list[dict]]:
    """One project's record, and any project it resolved to that still needs reading."""
    t0 = time.monotonic()
    rec: dict = {"key": item["key"], "url": item["url"]}
    follow: list[dict] = []
    try:
        head = item["key"].split("/", 1)[0]
        if head == "github.com":
            src = github_source(http, item, meta, input_keys)
        else:
            src = SOURCES.get(head, page_source)(http, item)
        rec["meta"] = src.meta
        if isinstance(src, Resolved):
            rec["status"] = "resolved"
            rec["resolved_to"] = src.item["key"]
            follow.append(src.item)
        else:
            if isinstance(src, Tree):
                files, extra = read_tree(src)
            else:
                files, extra = src.files, {}
            rec["notes"] = src.notes
            texts = [Text.of(p, decode(b)) for p, b in files if b"\x00" not in b[:8192]]
            evidence, signals, themes = analyze(texts)
            names = extra.pop("theme_names_from_paths", [])
            rec.update(status="ok", files=[p for p, _ in files], **extra,
                       content_digest=hashlib.sha1(" ".join(sorted(git_blob_sha(b) for _, b in files)).encode()).hexdigest(),
                       claude_evidence=evidence, signals=signals,
                       themes={"from_paths": names, **themes,
                               "light_dark": sorted({n for n in names + themes["named_in_content"]
                                                     if re.search(r"light|dark", n, re.I)})},
                       bytes_read=sum(len(b) for _, b in files))
    except Outcome as e:
        rec["status"] = e.status if e.status != "error" else f"error:{str(e)[:300]}"
        if e.status != "error":
            rec["reason"] = str(e)[:300]
    except Exception as e:  # a bug in this script, recorded on the project it hit
        rec["status"] = f"error:{type(e).__name__}: {str(e)[:300]}"
    rec["seconds"] = round(time.monotonic() - t0, 2)
    return rec, follow


# ───────────────────────────── the run ─────────────────────────────


def done_keys(out_path: str) -> tuple[set[str], list[dict]]:
    """Keys already recorded, and resolution targets recorded but never read themselves."""
    if not os.path.exists(out_path):
        return set(), []
    with open(out_path, "rb+") as f:
        data = f.read()
        if data and not data.endswith(b"\n"):  # a run killed mid-write left a torn last line
            cut = data.rfind(b"\n") + 1
            print(f"[resume] dropping a torn last line ({len(data) - cut} bytes); its project is redone",
                  file=sys.stderr)
            f.truncate(cut)
            data = data[:cut]
    keys, targets = set(), {}
    for n, line in enumerate(data.splitlines(), 1):
        rec = json.loads(line)  # a malformed line mid-file is corruption: let it stop the run
        keys.add(rec["key"])
        if rec.get("resolved_to"):
            targets[rec["resolved_to"]] = rec
    pending = [github_item(*rec["resolved_to"].split("/")[1:3], via=src) for t, rec in targets.items()
               if t not in keys for src in [rec["key"]]]
    return keys, pending


def load_items(args) -> tuple[list[dict], set[str]]:
    with open(args.input) as f:
        items = [json.loads(line) for line in f if line.strip()]
    all_keys = {i["key"] for i in items}
    wanted = set(args.keys or [])
    missing = wanted - all_keys
    if missing:
        sys.exit(f"--keys not in {args.input}: {', '.join(sorted(missing))}")
    if args.limit is None and not wanted:
        return items, all_keys
    limit = args.limit or 0
    return [it for n, it in enumerate(items) if n < limit or it["key"] in wanted], all_keys


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", default="/tmp/ccsl/merged.jsonl")
    ap.add_argument("--out", required=True, help="JSONL to append records to; its keys are skipped")
    ap.add_argument("--limit", type=int, help="only the first N projects of --input")
    ap.add_argument("--keys", nargs="+", help="only these keys (with --limit: these as well)")
    ap.add_argument("--workers", type=int, default=8, help="projects read at once (raw fetches)")
    ap.add_argument("--api-workers", type=int, default=3, help="GitHub API requests in flight at once")
    args = ap.parse_args()

    token = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True).stdout.strip()
    if not token:
        sys.exit("gh auth token printed nothing; run gh auth login")
    http = Http(token, args.api_workers)
    items, input_keys = load_items(args)
    done, followups = done_keys(args.out)
    queue = [it for it in items if it["key"] not in done] + followups
    total = len(items) + len(followups)
    seen = done | {it["key"] for it in queue}
    stats: Counter = Counter()
    prior = sum(1 for it in items if it["key"] in done)
    print(f"[start] {total} projects selected, {prior} already in {args.out}, {len(queue)} to read", flush=True)
    t_start = time.monotonic()
    finished = 0

    with open(args.out, "a") as out, cf.ThreadPoolExecutor(args.workers) as pool:
        in_flight: set[cf.Future] = set()
        while queue or in_flight:
            while queue and len(in_flight) < GQL_BATCH * 2:
                chunk, queue = queue[:GQL_BATCH], queue[GQL_BATCH:]
                refs = [tuple(it["key"].split("/")[1:3]) for it in chunk if it["key"].startswith("github.com/")]
                metas = github_meta(http, refs) if refs else {}
                for it in chunk:
                    meta = metas.get(tuple(it["key"].split("/")[1:3])) if it["key"].startswith("github.com/") else None
                    in_flight.add(pool.submit(process, http, it, meta, input_keys))
            ready, in_flight = cf.wait(in_flight, return_when=cf.FIRST_COMPLETED)
            for fut in ready:
                rec, follow = fut.result()
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                out.flush()
                finished += 1
                stats[rec["status"].split(":", 1)[0]] += 1
                for f in follow:
                    if f["key"] not in seen:
                        seen.add(f["key"])
                        queue.append(f)
                        total += 1
                if finished % 100 == 0:
                    progress(prior + finished, total, stats, http)
    elapsed = time.monotonic() - t_start
    progress(prior + finished, total, stats, http)
    print(f"[done] {finished} projects in {elapsed:.0f}s ({elapsed / max(finished, 1):.2f}s per project)", flush=True)


def progress(done: int, total: int, stats: Counter, http: Http) -> None:
    rest = http.limits.get("core", ("?", 0))[0]
    gql = http.limits.get("graphql", ("?", 0))[0]
    other = ", ".join(f"{k}={v}" for k, v in sorted(stats.items()) if k not in ("ok", "error"))
    print(f"[{time.strftime('%H:%M:%S')}] {done}/{total} ok={stats['ok']} errors={stats['error']} {other} "
          f"rest_remaining={rest} graphql_remaining={gql}", flush=True)


if __name__ == "__main__":
    main()
