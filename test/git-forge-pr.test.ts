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
} from "../src/segments/git";
import type { LaunchResult } from "../src/proc/launch";

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
    });
    expect(classify(okResult(out))).toEqual({
      kind: "ok",
      value: {
        number: 76,
        state: "OPEN",
        url: "https://github.com/promptctl/cc-candybar/pull/76",
      },
    });
  });

  test("merged PR for the branch → absent (not a value)", () => {
    const out = JSON.stringify({
      number: 76,
      state: "MERGED",
      url: "https://github.com/x/y/pull/76",
    });
    expect(classify(okResult(out))).toEqual({ kind: "absent" });
  });

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
    });
    expect(classify(okResult(out))).toEqual({
      kind: "ok",
      value: {
        number: 42,
        state: "opened",
        url: "https://gitlab.com/group/proj/-/merge_requests/42",
      },
    });
  });

  test("closed MR → absent", () => {
    const out = JSON.stringify({
      iid: 42,
      state: "closed",
      web_url: "https://gitlab.com/g/p/-/merge_requests/42",
    });
    expect(classify(okResult(out))).toEqual({ kind: "absent" });
  });

  test("no MR available → absent", () => {
    const r = failResult(
      "non-zero",
      "no open merge request available for branch",
    );
    expect(classify(r)).toEqual({ kind: "absent" });
  });
});
