// Was the bundle this daemon runs built from the source beside it? Compared by
// IDENTITY — the digest of `src/` now against the one the build baked in — because
// the baked version is exactly what a stale bundle reports wrongly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceDigest } from "../source-digest";
import { PACKAGE_VERSION } from "../version";

export interface SourceStamp {
  readonly version: string;
  readonly digest: string;
}

// [LAW:types-are-the-program] Every way the question can come out, as data. [LAW:no-silent-failure] `unchecked` is the check declining to answer — logged, never a stale-looking default, never a throw out of a timer.
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

// The bundle lives at `<root>/dist/index.mjs`, so the root is its grandparent.
function checkoutRootOf(bundlePath: string): string {
  return path.dirname(path.dirname(bundlePath));
}

// [LAW:no-silent-failure] A bundle carrying no digest cannot be compared and says so; "cannot check" must never read as "current".
export function bakedStamp(): SourceStamp {
  if (typeof __SOURCE_DIGEST__ === "undefined") {
    throw new Error(
      "this bundle carries no source digest (build via `pnpm build`, which stamps it)",
    );
  }
  return { version: PACKAGE_VERSION, digest: __SOURCE_DIGEST__ };
}

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

// [LAW:effects-at-boundaries] The one place this module touches the filesystem. The
// running stamp arrives as a reader so its own failure folds into `unchecked` too.
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
