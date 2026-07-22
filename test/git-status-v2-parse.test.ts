// [LAW:behavior-not-structure] The accept/reject shape table for the porcelain
// v2 parser, asserted against fixtures captured from REAL `git status
// --porcelain=v2 --branch` runs (clean/ahead/behind/dirty/detached/unborn/
// conflict). The parser is the single core git projection (brandon-daemon-perf
// -bb9.1); every field it lifts — branch, sha, upstream, ahead/behind, worktree
// status — must survive each state, so each state is one case here.

import { parseStatusV2 } from "../src/segments/git";
import { ABSENT, ok } from "../src/utils/outcome";

describe("parseStatusV2", () => {
  test("clean tracking branch, up to date", () => {
    const out = [
      "# branch.oid 0b0b58b683ccf6d126c5587730a4bb286e23919f",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
    ].join("\n");
    expect(parseStatusV2(out)).toEqual({
      branch: "main",
      status: "clean",
      sha: ok("0b0b58b"),
      upstream: ok("origin/main"),
      aheadBehind: ok({ ahead: 0, behind: 0 }),
      workingTree: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
    });
  });

  test("ahead and behind counts are parsed from branch.ab", () => {
    const out = [
      "# branch.oid 726672d263635fbbb3346e4e19883bba0298905d",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
    ].join("\n");
    const r = parseStatusV2(out);
    expect(r.aheadBehind).toEqual(ok({ ahead: 2, behind: 3 }));
  });

  test("no upstream: upstream and aheadBehind are absent, not a confident 0", () => {
    const out = [
      "# branch.oid 726672d263635fbbb3346e4e19883bba0298905d",
      "# branch.head nobranch",
    ].join("\n");
    const r = parseStatusV2(out);
    expect(r.branch).toBe("nobranch");
    expect(r.upstream).toEqual(ABSENT);
    expect(r.aheadBehind).toEqual(ABSENT);
  });

  test("detached HEAD → branch label 'detached'", () => {
    const out = [
      "# branch.oid ad52a9a878103de44448d5466d70e0a601612455",
      "# branch.head (detached)",
    ].join("\n");
    expect(parseStatusV2(out).branch).toBe("detached");
  });

  test("unborn HEAD → sha absent, branch is the initial branch, clean", () => {
    const out = ["# branch.oid (initial)", "# branch.head main"].join("\n");
    const r = parseStatusV2(out);
    expect(r.sha).toEqual(ABSENT);
    expect(r.branch).toBe("main");
    expect(r.status).toBe("clean");
  });

  test("unborn HEAD with an untracked file → dirty, untracked counted", () => {
    const out = [
      "# branch.oid (initial)",
      "# branch.head main",
      "? f.txt",
    ].join("\n");
    const r = parseStatusV2(out);
    expect(r.status).toBe("dirty");
    expect(r.workingTree.untracked).toBe(1);
  });

  test("staged only: XY = 'M.' → staged counted, worktree clean of that file", () => {
    const out = [
      "# branch.oid 12aab480909aeb0d72c5199bf3e14f2dfc957573",
      "# branch.head main",
      "1 M. N... 100644 100644 100644 12aab48 efbf425 a.txt",
    ].join("\n");
    const r = parseStatusV2(out);
    expect(r.workingTree).toMatchObject({ staged: 1, unstaged: 0 });
    expect(r.status).toBe("dirty");
  });

  test("unstaged only: XY = '.M' → unstaged counted", () => {
    const out = [
      "# branch.oid 12aab480909aeb0d72c5199bf3e14f2dfc957573",
      "# branch.head main",
      "1 .M N... 100644 100644 100644 12aab48 12aab48 a.txt",
    ].join("\n");
    const r = parseStatusV2(out);
    expect(r.workingTree).toMatchObject({ staged: 0, unstaged: 1 });
    expect(r.status).toBe("dirty");
  });

  test("mixed dirty + untracked, tracking, ahead", () => {
    const out = [
      "# branch.oid 726672d263635fbbb3346e4e19883bba0298905d",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -0",
      "1 MM N... 100644 100644 100644 ab98ef3 bf7883b a.txt",
      "? untracked.txt",
    ].join("\n");
    const r = parseStatusV2(out);
    expect(r.status).toBe("dirty");
    expect(r.aheadBehind).toEqual(ok({ ahead: 2, behind: 0 }));
    expect(r.workingTree).toEqual({
      staged: 1,
      unstaged: 1,
      untracked: 1,
      conflicts: 0,
    });
  });

  test("unmerged 'u' line → conflicts status wins over dirty", () => {
    const out = [
      "# branch.oid 4c5592cabba6ee07ef1398b81b8f9510ebe62d47",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +1 -0",
      "u UU N... 100644 100644 100644 100644 ce01362 92cb51d 033a5be a.txt",
    ].join("\n");
    const r = parseStatusV2(out);
    expect(r.status).toBe("conflicts");
    expect(r.workingTree.conflicts).toBe(1);
  });

  test("upstream present but branch.ab absent → upstream ok, aheadBehind absent", () => {
    // Reachable: upstream configured but the remote-tracking ref is missing, so
    // git emits `# branch.upstream` yet omits `# branch.ab` (can't compute).
    // aheadBehind must stay absent — not a fabricated "+0 -0".
    const out = [
      "# branch.oid d737dfec86b2ac139ae9f50310151acb9cea6378",
      "# branch.head master",
      "# branch.upstream origin/master",
    ].join("\n");
    const r = parseStatusV2(out);
    expect(r.upstream).toEqual(ok("origin/master"));
    expect(r.aheadBehind).toEqual(ABSENT);
  });

  test("malformed branch.ab line → aheadBehind stays absent, never fabricated", () => {
    const out = [
      "# branch.oid 726672d263635fbbb3346e4e19883bba0298905d",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab garbage",
    ].join("\n");
    expect(parseStatusV2(out).aheadBehind).toEqual(ABSENT);
  });

  test("rename '2' line counts staged from its XY", () => {
    // A pure rename is staged (R.); its XY columns parse like an ordinary change.
    const out = [
      "# branch.oid 4c5592cabba6ee07ef1398b81b8f9510ebe62d47",
      "# branch.head main",
      "2 R. N... 100644 100644 100644 ce01362 ce01362 R100 new.txt\told.txt",
    ].join("\n");
    const r = parseStatusV2(out);
    expect(r.workingTree).toMatchObject({ staged: 1, unstaged: 0 });
    expect(r.status).toBe("dirty");
  });
});
