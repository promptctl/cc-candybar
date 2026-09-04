// Is the bundle this daemon runs older than the source beside it? `dist/` is
// gitignored, so a checkout can pull eleven releases of source while
// `git status` stays clean and the statusline keeps rendering a bundle built
// from none of it. The protocol handshake cannot see this — PROTOCOL_VERSION
// is a wire-compatibility integer that correctly does not track releases —
// and the baked package version is exactly the thing a stale bundle reports
// wrongly. The only honest comparison is the one this module makes: the
// bundle's mtime against the newest mtime under `src/`.
//
// A published install has no `src/` beside `dist/` (the tarball ships only
// `dist`/`bin`/`plugin`/`schema`; the staged runtime under Application Support
// copies `dist` and `bin`), so for every real user the verdict is the typed
// `not-source-checkout` — not a warning, not an error, the normal case.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonLogger } from "./log";

export interface Stamp {
  readonly path: string;
  readonly mtimeMs: number;
}

// [LAW:types-are-the-program] Every way the question can come out, as data.
// `stale` and `current` carry both stamps so the report can name them;
// `not-source-checkout` is the published-install shape; `unchecked` is the
// advisory check declining to answer (the bundle vanished mid-sample, a
// source file raced a `git pull` between readdir and stat) — a typed failure
// that gets logged, never a stale-looking default and never a throw out of a
// timer callback into the daemon. [LAW:no-silent-failure]
export type BuildCurrency =
  | {
      readonly kind: "current";
      readonly bundle: Stamp;
      readonly newestSource: Stamp;
    }
  | {
      readonly kind: "stale";
      readonly bundle: Stamp;
      readonly newestSource: Stamp;
    }
  | { readonly kind: "not-source-checkout" }
  | { readonly kind: "unchecked"; readonly reason: string };

// The checkout root is the bundle's grandparent (`<root>/dist/index.mjs`),
// and the source it was built from is `<root>/src`.
function checkoutRootOf(bundlePath: string): string {
  return path.dirname(path.dirname(bundlePath));
}

// Dotfiles and `~` backups are never source: `.DS_Store` is rewritten by
// Finder browsing a directory and editors park swap files beside the file
// being edited, so counting them would fake a stale verdict from no source
// change at all. A deny-list of "never source" holds for every bundler; an
// extension allow-list would be a second copy of the import graph.
const isSourceEntry = (name: string): boolean =>
  !name.startsWith(".") && !name.endsWith("~");

// Every source file under `dir`, recursively. Symlinks are stat-followed
// like any other entry; directories recurse.
function fileStamps(dir: string): Stamp[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => isSourceEntry(entry.name))
    .flatMap((entry) => {
      const p = path.join(dir, entry.name);
      return entry.isDirectory()
        ? fileStamps(p)
        : [{ path: p, mtimeMs: fs.statSync(p).mtimeMs }];
    });
}

// [LAW:effects-at-boundaries] The one place this module touches the
// filesystem: two stats' worth of facts (bundle mtime, newest source mtime)
// folded into one verdict. Takes the daemon's entry URL as `import.meta.url`
// hands it over, so the caller has nothing to pre-resolve — a non-file URL
// is one more way the comparison cannot be made, and it is `unchecked` like
// the others rather than a guard at the call site.
export function assessBuild(entryUrl: string): BuildCurrency {
  try {
    const bundlePath = fileURLToPath(entryUrl);
    const srcDir = path.join(checkoutRootOf(bundlePath), "src");
    if (!fs.existsSync(srcDir)) return { kind: "not-source-checkout" };
    const sources = fileStamps(srcDir);
    if (sources.length === 0) return { kind: "not-source-checkout" };
    const newestSource = sources.reduce((a, b) =>
      b.mtimeMs > a.mtimeMs ? b : a,
    );
    const bundle: Stamp = {
      path: bundlePath,
      mtimeMs: fs.statSync(bundlePath).mtimeMs,
    };
    return bundle.mtimeMs < newestSource.mtimeMs
      ? { kind: "stale", bundle, newestSource }
      : { kind: "current", bundle, newestSource };
  } catch (e) {
    return { kind: "unchecked", reason: (e as Error).message };
  }
}

// Local wall-clock to the second, the resolution a developer compares
// against `ls -l` and their own memory of when they last ran a build.
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const REBUILD_HINT =
  "rebuild: `just deploy` (or `pnpm dev` for a watch build)";

// [LAW:dataflow-not-control-flow] Total projection of the verdict onto the
// daemon's advisory warning channel. Only `stale` has anything to say; the
// text names both timestamps (paths relative to the checkout root) on one
// row and the fix on the next, so the visible rows never truncate the
// command a reader needs to run. `current`, `not-source-checkout`, and
// `unchecked` all render nothing — the last is reported through the log,
// where a check that could not run belongs.
export function buildCurrencyWarning(verdict: BuildCurrency): string | null {
  if (verdict.kind !== "stale") return null;
  const root = checkoutRootOf(verdict.bundle.path);
  const rel = (s: Stamp) => path.relative(root, s.path);
  return (
    `stale build: ${rel(verdict.bundle)} ${localStamp(verdict.bundle.mtimeMs)}` +
    ` < ${rel(verdict.newestSource)} ${localStamp(verdict.newestSource.mtimeMs)}\n` +
    REBUILD_HINT
  );
}

// One log line per verdict, stable across samples so a transition is visible
// and a steady state is silent.
function describe(verdict: BuildCurrency): string {
  switch (verdict.kind) {
    case "stale":
    case "current":
      return `${verdict.kind} (bundle ${localStamp(verdict.bundle.mtimeMs)}, newest source ${verdict.newestSource.path} ${localStamp(verdict.newestSource.mtimeMs)})`;
    case "not-source-checkout":
      return "not a source checkout";
    case "unchecked":
      return `unchecked: ${verdict.reason}`;
  }
}

export interface BuildWatchDeps {
  readonly entryUrl: string;
  readonly intervalMs: number;
  readonly log: DaemonLogger;
}

export interface BuildWatch {
  // Takes the first sample synchronously — the first render already carries
  // the verdict — then resamples every `intervalMs`, unref'd so the timer
  // never holds the process alive.
  arm(): void;
  // The latest sample projected onto the warning channel.
  warning(): string | null;
}

// [LAW:no-ambient-temporal-coupling] The sampler is the one owner of how
// fresh the verdict is. Source can change under a running daemon (a pull, an
// edit) while the bundle cannot — the binary watch restarts the daemon when
// the bundle changes — so the verdict is re-derived on a clock and the render
// path reads the latest value; it never walks `src/` itself.
export function makeBuildWatch(deps: BuildWatchDeps): BuildWatch {
  let latest: BuildCurrency = { kind: "unchecked", reason: "not yet sampled" };
  let lastLogged = "";
  const sample = (): void => {
    latest = assessBuild(deps.entryUrl);
    const line = describe(latest);
    if (line !== lastLogged) {
      lastLogged = line;
      deps.log(
        latest.kind === "unchecked" ? "warn" : "info",
        `build currency: ${line}`,
      );
    }
  };
  return {
    arm() {
      sample();
      setInterval(sample, deps.intervalMs).unref();
    },
    warning: () => buildCurrencyWarning(latest),
  };
}
