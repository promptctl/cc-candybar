// Was the bundle this daemon runs built from the source beside it? `dist/`
// is gitignored, so a checkout can pull eleven releases of source while
// `git status` stays clean and the statusline keeps rendering a bundle built
// from none of it. The protocol handshake cannot see this — PROTOCOL_VERSION
// is a wire-compatibility integer that correctly does not track releases —
// and the baked package version is exactly the thing a stale bundle reports
// wrongly. The honest comparison is by IDENTITY: the digest of `src/` now
// against the digest the build baked into the bundle (src/source-digest.ts,
// stamped by tsdown.config.ts). An mtime comparison, the previous design,
// fired on every `git checkout` — a branch switch rewrites mtimes on files
// whose bytes did not change — and a notice that cries wolf trains the
// reader to dismiss the real one (brandon-build-notice-5d6).
//
// A published install has no `src/` beside `dist/` (the tarball ships only
// `dist`/`bin`/`plugin`/`schema`; the staged runtime under Application Support
// copies `dist` and `bin`), so for every real user the verdict is the typed
// `not-source-checkout` — not a warning, not an error, the normal case.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceDigest } from "../source-digest";
import { PACKAGE_VERSION } from "../version";

// What identifies a build to a person: the version it reports and the
// digest of the source it was built from.
export interface SourceStamp {
  readonly version: string;
  readonly digest: string;
}

// [LAW:types-are-the-program] Every way the question can come out, as data.
// `stale` carries both stamps so the notice can name them; `current` carries
// the one they agree on; `not-source-checkout` is the published-install
// shape; `unchecked` is the advisory check declining to answer (the bundle
// carries no digest, the source raced a `git pull` between readdir and read,
// the checkout's package.json is unreadable) — a typed failure that gets
// logged, never a stale-looking default and never a throw out of a timer
// callback into the daemon. [LAW:no-silent-failure]
export type BuildCurrency =
  | {
      readonly kind: "current";
      readonly root: string;
      readonly stamp: SourceStamp;
    }
  | {
      readonly kind: "stale";
      readonly root: string;
      readonly source: SourceStamp;
      readonly running: SourceStamp;
    }
  | { readonly kind: "not-source-checkout" }
  | { readonly kind: "unchecked"; readonly reason: string };

// The checkout root is the bundle's grandparent (`<root>/dist/index.mjs`),
// and the source it was built from is `<root>/src`.
function checkoutRootOf(bundlePath: string): string {
  return path.dirname(path.dirname(bundlePath));
}

// [LAW:no-silent-failure] The stamp of the code that is RUNNING. A bundle
// without the digest cannot be compared, and says so: it was built by
// something other than tsdown.config.ts (or runs untranspiled), and "cannot
// check" must never read as "current" — the throw lands in assessBuild's
// `unchecked` arm like every other way the comparison cannot be made.
export function bakedStamp(): SourceStamp {
  if (typeof __SOURCE_DIGEST__ === "undefined") {
    throw new Error(
      "this bundle carries no source digest (build via `pnpm build`, which stamps it)",
    );
  }
  return { version: PACKAGE_VERSION, digest: __SOURCE_DIGEST__ };
}

// The version the checkout's source would report once built — read from
// its package.json, the same authority the build bakes PACKAGE_VERSION from.
function checkoutVersion(root: string): string {
  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const version =
    typeof raw === "object" && raw !== null
      ? (raw as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string") {
    throw new Error(`${path.join(root, "package.json")} has no version string`);
  }
  return version;
}

// [LAW:effects-at-boundaries] The one place this module touches the
// filesystem: the source digest and the checkout's version, folded with the
// running stamp into one verdict. Takes the daemon's entry URL as
// `import.meta.url` hands it over, so the caller has nothing to pre-resolve —
// a non-file URL is one more way the comparison cannot be made, and it is
// `unchecked` like the others rather than a guard at the call site. The
// running stamp arrives as a reader (bakedStamp in production, a literal in
// tests) so its own failure folds into the same `unchecked` arm.
export function assessBuild(
  entryUrl: string,
  runningStamp: () => SourceStamp,
): BuildCurrency {
  try {
    const root = checkoutRootOf(fileURLToPath(entryUrl));
    const srcDir = path.join(root, "src");
    if (!fs.existsSync(srcDir)) return { kind: "not-source-checkout" };
    const running = runningStamp();
    const digest = sourceDigest(srcDir);
    if (digest === running.digest)
      return { kind: "current", root, stamp: running };
    return {
      kind: "stale",
      root,
      source: { version: checkoutVersion(root), digest },
      running,
    };
  } catch (e) {
    return { kind: "unchecked", reason: (e as Error).message };
  }
}
