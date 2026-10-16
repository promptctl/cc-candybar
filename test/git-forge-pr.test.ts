// Forge PR/MR classification contract. The accept/reject table that decides
// whether a forge-CLI launch result is an open PR (`ok`), genuinely none / no
// integration (`absent`), or a lookup failure that must stay VISIBLE
// (`failed`). [LAW:no-silent-failure] The whole point of the table is that a
// transient forge outage never collapses into the same render state as "no PR".

import {
  classifyForgePr,
  detectForge,
  parseGithubPr,
  parseGitlabMr,
  prOfHead,
  type PrState,
} from "../src/segments/git";
import type { LaunchResult } from "../src/proc/launch";
import { ABSENT, failed, ok } from "../src/utils/outcome";

const okResult = (stdout: string): LaunchResult => ({
  ok: true,
  stdout,
  stderr: "",
  exitCode: 0,
});

const failResult = (
  reason: "non-zero" | "spawn-error" | "timeout" | "signal" | "rate-limited",
  stderr = "",
  error?: string,
): LaunchResult => ({
  ok: false,
  reason,
  stdout: "",
  stderr,
  exitCode: reason === "non-zero" ? 1 : null,
  signal: null,
  ...(error !== undefined && { error }),
});

const GH_NO_PR = /no (open )?pull requests? found/i;
const GLAB_NO_MR = /no (open )?merge requests? (found|available)/i;

describe("detectForge", () => {
  test.each([
    ["git@github.com:promptctl/cc-candybar.git", "github"],
    ["https://github.com/promptctl/cc-candybar.git", "github"],
    ["git@gitlab.com:group/proj.git", "gitlab"],
    ["https://gitlab.example.com/group/proj.git", "gitlab"],
    ["git@bitbucket.org:team/repo.git", null],
    ["https://git.sr.ht/~user/repo", null],
    ["ssh://git@gitlab.example.com:22/group/proj.git", "gitlab"],
    // Host-based, not substring: a repo NAMED gitlab/github on another host
    // must NOT misdispatch (the bug a whole-URL substring match would have).
    ["git@github.com:foo/gitlab-mirror.git", "github"],
    ["git@example.com:team/gitlab.git", null],
    ["https://example.com/org/github.com-clone.git", null],
  ])("%s → %s", (url, expected) => {
    expect(detectForge(url)).toBe(expected);
  });
});

describe("classifyForgePr (github)", () => {
  const classify = (r: LaunchResult) =>
    classifyForgePr("gh pr view", r, GH_NO_PR, parseGithubPr);

  test("open PR → ok", () => {
    const out = JSON.stringify({
      number: 76,
      state: "OPEN",
      url: "https://github.com/promptctl/cc-candybar/pull/76",
      headRefOid: "c0ffee",
    });
    expect(classify(okResult(out))).toEqual({
      kind: "ok",
      value: {
        number: 76,
        state: "open",
        url: "https://github.com/promptctl/cc-candybar/pull/76",
        head: "c0ffee",
      },
    });
  });

  test.each([
    ["MERGED", "merged"],
    ["CLOSED", "closed"],
  ])("a %s PR for the branch → ok, state %s", (state, parsed) => {
    const url = "https://github.com/x/y/pull/76";
    const out = JSON.stringify({ number: 76, state, url, headRefOid: "c0ffee" });
    expect(classify(okResult(out))).toEqual({
      kind: "ok",
      value: { number: 76, state: parsed, url, head: "c0ffee" },
    });
  });

  test.each(["DRAFT", "open", ""])(
    "a state word gh does not print (%j) → failed, naming it",
    (state) => {
      const out = JSON.stringify({ number: 76, state, url: "https://x/76", headRefOid: "c0ffee" });
      const r = classify(okResult(out));
      expect(r).toEqual({
        kind: "failed",
        reason: `gh pr view: unknown state ${JSON.stringify(state)}`,
      });
    },
  );

  test('no PR for branch (exit 1 + "no pull requests found") → absent', () => {
    const r = failResult(
      "non-zero",
      'no pull requests found for branch "brandon-git-76s"',
    );
    expect(classify(r)).toEqual({ kind: "absent" });
  });

  test("gh not installed (ENOENT spawn-error) → absent, not failed", () => {
    expect(classify(failResult("spawn-error", "", "spawn gh ENOENT"))).toEqual({
      kind: "absent",
    });
  });

  test("gh present but unlaunchable (EACCES spawn-error) → failed (visible)", () => {
    // [LAW:no-silent-failure] Only a MISSING binary is absent; a CLI that
    // exists but can't launch is a real failure, not "no PR".
    const r = classify(failResult("spawn-error", "", "spawn gh EACCES"));
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toMatch(/gh pr view/);
  });

  test("auth failure (exit 1, HTTP 401) → failed (visible, distinct)", () => {
    const r = classify(failResult("non-zero", "HTTP 401: Bad credentials"));
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toMatch(/gh pr view/);
  });

  test("timeout → failed", () => {
    expect(classify(failResult("timeout")).kind).toBe("failed");
  });

  test("unparseable JSON on a clean exit → failed", () => {
    expect(classify(okResult("not json")).kind).toBe("failed");
  });

  test("JSON missing fields → failed", () => {
    expect(classify(okResult(JSON.stringify({ number: 1 }))).kind).toBe(
      "failed",
    );
  });
});

describe("classifyForgePr (gitlab)", () => {
  const classify = (r: LaunchResult) =>
    classifyForgePr("glab mr view", r, GLAB_NO_MR, parseGitlabMr);

  test("opened MR → ok (iid → number, web_url → url)", () => {
    const out = JSON.stringify({
      iid: 42,
      state: "opened",
      web_url: "https://gitlab.com/group/proj/-/merge_requests/42",
      sha: "c0ffee",
    });
    expect(classify(okResult(out))).toEqual({
      kind: "ok",
      value: {
        number: 42,
        state: "open",
        url: "https://gitlab.com/group/proj/-/merge_requests/42",
        head: "c0ffee",
      },
    });
  });

  test.each([
    ["locked", "open"],
    ["merged", "merged"],
    ["closed", "closed"],
  ])("a %s MR → ok, state %s", (state, parsed) => {
    const url = "https://gitlab.com/g/p/-/merge_requests/42";
    const out = JSON.stringify({ iid: 42, state, web_url: url, sha: "c0ffee" });
    expect(classify(okResult(out))).toEqual({
      kind: "ok",
      value: { number: 42, state: parsed, url, head: "c0ffee" },
    });
  });

  test("a state word glab does not print → failed, naming it", () => {
    const out = JSON.stringify({ iid: 42, state: "OPENED", web_url: "https://x/42", sha: "c0ffee" });
    expect(classify(okResult(out))).toEqual({
      kind: "failed",
      reason: 'glab mr view: unknown state "OPENED"',
    });
  });

  test("no MR available → absent", () => {
    const r = failResult(
      "non-zero",
      "no open merge request available for branch",
    );
    expect(classify(r)).toEqual({ kind: "absent" });
  });
});

// A branch name reused after its PR concluded gets that PR back from the
// forge: it is the branch's only while HEAD is still the PR's head.
describe("prOfHead", () => {
  const pull = (state: PrState) => ({
    number: 7,
    state,
    url: "https://x/7",
    head: "aaa",
  });
  const pr = (state: PrState) => ok(pull(state));

  test.each<[PrState, string, boolean]>([
    ["open", "aaa", true],
    ["open", "bbb", true],
    ["merged", "aaa", true],
    ["merged", "bbb", false],
    ["closed", "aaa", true],
    ["closed", "bbb", false],
  ])("a %s PR, HEAD %s → the branch's: %s", (state, head, kept) => {
    expect(prOfHead(pr(state), ok(head))).toEqual(
      kept ? pr(state) : { kind: "earlier", value: pull(state) },
    );
  });

  test("an unborn HEAD's concluded PR is an earlier one; an unreadable HEAD fails it", () => {
    expect(prOfHead(pr("merged"), ABSENT)).toEqual({
      kind: "earlier",
      value: pull("merged"),
    });
    expect(prOfHead(pr("closed"), failed("no oid"))).toEqual(
      failed("HEAD: no oid"),
    );
    expect(prOfHead(pr("open"), failed("no oid"))).toEqual(pr("open"));
  });

  test("no PR and a failed lookup pass through", () => {
    expect(prOfHead(ABSENT, ok("aaa"))).toEqual(ABSENT);
    const f = failed("gh pr view: HTTP 401");
    expect(prOfHead(f, ok("aaa"))).toEqual(f);
  });
});
