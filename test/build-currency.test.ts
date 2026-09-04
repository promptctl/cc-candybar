// [LAW:behavior-not-structure] The contract of the build verdict, pinned in a
// scratch checkout with the running stamp injected: identity is the source
// DIGEST, so the same bytes are current whatever their mtimes say, and every
// way the comparison cannot be made is the typed `unchecked`, never a
// stale-looking default (brandon-build-notice-5d6, before it candybar-build-2s5).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assessBuild,
  bakedStamp,
  type SourceStamp,
} from "../src/daemon/build-currency";
import { sourceDigest } from "../src/source-digest";

const HOUR_S = 60 * 60;

interface Scratch {
  readonly root: string;
  readonly entryUrl: string;
  readonly src: string;
  readonly running: SourceStamp;
}

// A checkout root with `dist/index.mjs`, a package.json, and two source
// files — and the stamp a bundle built from exactly this source would carry.
function scratchCheckout(): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-build-"));
  const bundle = path.join(root, "dist", "index.mjs");
  fs.mkdirSync(path.dirname(bundle));
  fs.writeFileSync(bundle, "// bundle");
  fs.writeFileSync(path.join(root, "package.json"), '{ "version": "9.9.9" }\n');
  const src = path.join(root, "src");
  fs.mkdirSync(path.join(src, "daemon", "cache"), { recursive: true });
  fs.writeFileSync(path.join(src, "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(src, "daemon", "cache", "render.ts"), "render\n");
  return {
    root,
    entryUrl: pathToFileURL(bundle).href,
    src,
    running: { version: "1.0.0", digest: sourceDigest(src) },
  };
}

function bumpMtimes(dir: string): void {
  const t = Date.now() / 1000 + HOUR_S;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isDirectory()) bumpMtimes(p);
    fs.lutimesSync(p, t, t);
  }
}

describe("assessBuild", () => {
  let c: Scratch;
  beforeEach(() => {
    c = scratchCheckout();
  });
  afterEach(() => {
    fs.rmSync(c.root, { recursive: true, force: true });
  });

  test("a bundle built from this source is current, carrying the stamp both agree on", () => {
    expect(assessBuild(c.entryUrl, () => c.running)).toEqual({
      kind: "current",
      root: c.root,
      stamp: c.running,
    });
  });

  // The ticket's criterion: a checkout/rebase rewrites mtimes on files whose
  // bytes did not change, and that must not read as stale.
  test("mtime churn over unchanged content is current", () => {
    bumpMtimes(c.src);
    expect(assessBuild(c.entryUrl, () => c.running).kind).toBe("current");
  });

  test("a content edit is stale, naming the checkout's version and digest beside the running ones", () => {
    fs.appendFileSync(path.join(c.src, "daemon", "cache", "render.ts"), "// edit\n");
    expect(assessBuild(c.entryUrl, () => c.running)).toEqual({
      kind: "stale",
      root: c.root,
      source: { version: "9.9.9", digest: sourceDigest(c.src) },
      running: c.running,
    });
  });

  test("dotfiles and ~ backups are not source and do not make it stale", () => {
    fs.writeFileSync(path.join(c.src, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(c.src, "daemon", ".render.ts.swp"), "vim");
    fs.writeFileSync(path.join(c.src, "index.ts~"), "emacs");
    expect(assessBuild(c.entryUrl, () => c.running).kind).toBe("current");
  });

  test("an empty src/ is a source tree the bundle was not built from: stale", () => {
    fs.rmSync(c.src, { recursive: true });
    fs.mkdirSync(c.src);
    expect(assessBuild(c.entryUrl, () => c.running).kind).toBe("stale");
  });

  test("no src/ beside dist/ is the published-install shape, not a verdict", () => {
    fs.rmSync(c.src, { recursive: true });
    expect(assessBuild(c.entryUrl, () => c.running)).toEqual({
      kind: "not-source-checkout",
    });
  });

  // [LAW:no-silent-failure] Every way the comparison cannot be made is said.
  test("a stale checkout without a readable package.json version is unchecked naming the file", () => {
    fs.appendFileSync(path.join(c.src, "index.ts"), "// edit\n");
    fs.writeFileSync(path.join(c.root, "package.json"), "{}");
    const v = assessBuild(c.entryUrl, () => c.running);
    expect(v.kind).toBe("unchecked");
    if (v.kind === "unchecked") expect(v.reason).toMatch(/package\.json has no version/);
  });

  test("a running stamp that cannot be read is unchecked with its reason", () => {
    const v = assessBuild(c.entryUrl, () => {
      throw new Error("no digest baked");
    });
    expect(v).toEqual({ kind: "unchecked", reason: "no digest baked" });
  });

  test("a non-file entry URL is unchecked", () => {
    expect(assessBuild("data:text/javascript,", () => c.running).kind).toBe("unchecked");
  });

  // Root ignores directory permissions, so the condition cannot be built.
  (process.getuid?.() === 0 ? test.skip : test)(
    "an unreadable source directory is unchecked naming the reason, never a verdict over partial source",
    () => {
      const dir = path.join(c.src, "daemon");
      fs.chmodSync(dir, 0o000);
      try {
        const v = assessBuild(c.entryUrl, () => c.running);
        expect(v.kind).toBe("unchecked");
        if (v.kind === "unchecked") expect(v.reason).toMatch(/EACCES/);
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    },
  );
});

// [LAW:no-silent-failure] Untranspiled source (this test) carries no digest:
// the production reader says so, and through assessBuild that is the typed
// `unchecked` — "cannot check" never reads as "current".
test("a runtime without a baked digest cannot be compared, and says so", () => {
  expect(() => bakedStamp()).toThrow(/no source digest/);
  const c = scratchCheckout();
  try {
    const v = assessBuild(c.entryUrl, bakedStamp);
    expect(v.kind).toBe("unchecked");
    if (v.kind === "unchecked") expect(v.reason).toMatch(/pnpm build/);
  } finally {
    fs.rmSync(c.root, { recursive: true, force: true });
  }
});
