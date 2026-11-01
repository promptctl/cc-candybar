// [LAW:verifiable-goals] brandon-doctor-v62x.onf, "segments have their data":
// the row fails, naming the segments and the remedy, for each outside source
// a placed segment needs and does not have, and is ok when nothing needs it
// or everything is there. The facts are built per arm; the forge probe also
// runs for real against a checkout and a stub `gh` on PATH.
// [LAW:behavior-not-structure] Assertions are on the verdict, the doctor's
// event field, and what a payload or the daemon's stats say — never on how
// they are computed.

import { processLauncher } from "../src/proc/launch";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkByName,
  type DoctorFacts,
  type SegmentDataFacts,
} from "../src/doctor/checks";
import { forgeLogin, forgeLoginOf } from "../src/doctor/edge";
import { dataFields } from "../src/doctor/report";
import { rateLimitsOf } from "../src/doctor/cli";
import { parseRateLimitSightings } from "../src/doctor/daemon-answer";
import { rateLimitsSeen } from "../src/daemon/render-sightings";
import { RuntimeStats } from "../src/daemon/stats";
import type { StatsSnapshot } from "../src/daemon/stats";
import { HEALTHY_FACTS } from "./helpers/doctor-facts";

const segmentData = checkByName("segmentData")!;

const withData = (data: Partial<SegmentDataFacts>): DoctorFacts => ({
  ...HEALTHY_FACTS,
  data: { ...HEALTHY_FACTS.data, ...data },
});
const verdict = (data: Partial<SegmentDataFacts>) =>
  segmentData.probe(withData(data));

const forgeNeed = (
  fact: Extract<SegmentDataFacts["pullRequests"], { kind: "needed" }>["fact"],
): SegmentDataFacts["pullRequests"] => ({
  kind: "needed",
  segments: ["gitPr"],
  fact,
});
const login = (status: "ready" | "missing" | { loggedOut: string }) =>
  forgeNeed({ kind: "ok", value: { cli: "gh", host: "github.com", status } });

const rateNeed = (
  fact: Extract<SegmentDataFacts["rateLimits"], { kind: "needed" }>["fact"],
): SegmentDataFacts["rateLimits"] => ({
  kind: "needed",
  segments: ["block", "weekly"],
  fact,
});

describe("segment data row", () => {
  test("nothing needed is ok", async () => {
    expect(verdict({})).toEqual({ ok: true });
  });

  test("every source there is ok", async () => {
    expect(
      verdict({
        pullRequests: login("ready"),
        rateLimits: rateNeed({ kind: "ok", value: ["carried", "unanswered"] }),
      }),
    ).toEqual({ ok: true });
  });

  test("a checkout that names no forge has no PR to need", async () => {
    expect(
      verdict({ pullRequests: forgeNeed({ kind: "ok", value: null }) }),
    ).toEqual({ ok: true });
  });

  test("gh not installed names the segment, the CLI and the opt-out", async () => {
    expect(verdict({ pullRequests: login("missing") })).toEqual({
      ok: false,
      reason:
        'gitPr: gh is not installed, so no pull request is ever shown — install it, or set missingData: "ignore" on gitPr',
      more: [],
    });
  });

  test("gh logged out names the host and the login command", async () => {
    expect(
      verdict({
        pullRequests: login({
          loggedOut: "no oauth token found for github.com",
        }),
      }),
    ).toMatchObject({
      ok: false,
      reason:
        'gitPr: gh is not logged in to github.com (no oauth token found for github.com) — run `gh auth login --hostname github.com`, or set missingData: "ignore" on gitPr',
    });
  });

  test("a forge that could not be asked fails with why", async () => {
    expect(
      verdict({
        pullRequests: forgeNeed({ kind: "failed", reason: "git: exit 128" }),
      }),
    ).toMatchObject({
      ok: false,
      reason:
        "gitPr: whether the forge CLI is ready could not be asked: git: exit 128",
    });
  });

  test("one session carrying the windows is this Claude Code sending them", async () => {
    expect(
      verdict({ rateLimits: rateNeed({ kind: "ok", value: ["carried", "missing"] }) }),
    ).toEqual({ ok: true });
  });

  test("a response with no render carrying rate_limits fails", async () => {
    expect(
      verdict({ rateLimits: rateNeed({ kind: "ok", value: ["missing", "unanswered"] }) }),
    ).toMatchObject({
      ok: false,
      reason:
        'block, weekly: Claude Code sent no rate_limits — it sends them only to Claude.ai subscription sessions; on any other account, set missingData: "ignore" on block, weekly',
    });
  });

  test("renders before any response say nothing either way", async () => {
    expect(
      verdict({ rateLimits: rateNeed({ kind: "ok", value: ["unanswered"] }) }),
    ).toEqual({ ok: true });
  });

  test("no render seen is a failure saying so, not a pass", async () => {
    expect(
      verdict({ rateLimits: rateNeed({ kind: "ok", value: [] }) }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^block, weekly: no session of this Claude Code has drawn a bar/) });
  });

  test("a click from a bar this daemon never served says the daemon restarted", async () => {
    expect(
      segmentData.probe({
        ...withData({ rateLimits: rateNeed({ kind: "ok", value: [] }) }),
        sighted: { kind: "clicked", sessionId: "s1", via: "link" },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /^block, weekly: this daemon holds no render of this bar \(it restarted since the bar was drawn, or has served 64 newer sessions\)/,
      ),
    });
  });

  test("several problems lead with one and list the rest", async () => {
    const v = verdict({
      pullRequests: login("missing"),
      rateLimits: rateNeed({ kind: "failed", reason: "EACCES" }),
    });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.more).toHaveLength(1);
  });
});

describe("the doctor's event field", () => {
  test("names what each source found, `-` where nothing needs it", async () => {
    expect(dataFields(HEALTHY_FACTS.data)).toBe(
      "data=pr:-,rateLimits:-",
    );
    expect(
      dataFields({
        pullRequests: login({ loggedOut: "x" }),
        rateLimits: rateNeed({
          kind: "ok",
          value: ["carried", "missing", "unanswered", "carried"],
        }),
      }),
    ).toBe("data=pr:logged-out,rateLimits:2/1/1");
    expect(
      dataFields({
        pullRequests: forgeNeed({ kind: "ok", value: null }),
        rateLimits: rateNeed({ kind: "failed", reason: "r" }),
      }),
    ).toBe("data=pr:no-forge,rateLimits:failed");
  });
});

describe("what a hook payload says of the rate-limit windows", () => {
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const window = (current_usage: typeof usage | null) => ({
    total_input_tokens: 0,
    total_output_tokens: 0,
    context_window_size: 200000,
    used_percentage: null,
    remaining_percentage: null,
    current_usage,
  });

  test("either window present is carried", async () => {
    const at = { used_percentage: 10, resets_at: 0 };
    expect(
      rateLimitsSeen({
        rate_limits: { five_hour: at },
        context_window: window(null),
      }),
    ).toBe("carried");
    expect(
      rateLimitsSeen({
        rate_limits: { seven_day: at },
        context_window: window(usage),
      }),
    ).toBe("carried");
  });
  test("a rate_limits holding no window is missing, as the payload reads it", async () => {
    expect(
      rateLimitsSeen({ rate_limits: {}, context_window: window(usage) }),
    ).toBe("missing");
  });
  test("none after a response is missing", async () => {
    expect(rateLimitsSeen({ context_window: window(usage) })).toBe("missing");
  });
  test("none before the first response (or right after /compact) is unanswered", async () => {
    expect(rateLimitsSeen({ context_window: window(null) })).toBe("unanswered");
  });
  test("a Claude Code too old to send a context window sends no windows: missing", async () => {
    expect(rateLimitsSeen({})).toBe("missing");
  });
});

describe("the command's rate-limit sightings", () => {
  const sightings = {
    kind: "ok",
    value: [
      { rateLimits: "carried", claudeConfigDir: "/a", sessionId: "s1", ago: 1 },
      { rateLimits: "missing", claudeConfigDir: "/zai", sessionId: "s2", ago: 1 },
      { rateLimits: "missing", claudeConfigDir: "/a", sessionId: "s3", ago: 100000 },
    ],
  } as const;

  test("only recent renders of sessions in its own Claude Code directory", async () => {
    expect(rateLimitsOf({ kind: "recent" }, sightings, "/a")).toEqual({
      kind: "ok",
      value: ["carried"],
    });
  });

  // Run in a session's shell, its own renders alone, however long ago
  // (brandon-doctor-v62x.y5d).
  test("in a session, that session's renders alone", async () => {
    expect(
      rateLimitsOf({ kind: "shell", sessionId: "s3" }, sightings, "/a"),
    ).toEqual({ kind: "ok", value: ["missing"] });
  });

  test("a daemon that could not be asked stays failed", async () => {
    expect(rateLimitsOf({ kind: "recent" }, { kind: "failed", reason: "down" }, "/a")).toEqual({
      kind: "failed",
      reason: "down",
    });
  });

  test("the daemon's stats are read, and an older daemon's are refused by name", async () => {
    const stats = (clients: unknown[]): StatsSnapshot =>
      ({
        ...RuntimeStats.referenceSnapshot(),
        version: "9.9.9",
        clients,
      }) as unknown as StatsSnapshot;
    expect(
      parseRateLimitSightings(
        stats([
          {
            client: null,
            rateLimits: "unanswered",
            claudeConfigDir: "/a",
            sessionId: "s1",
            ago: 3,
          },
        ]),
      ),
    ).toEqual({
      kind: "ok",
      value: [
        {
          client: null,
          rateLimits: "unanswered",
          claudeConfigDir: "/a",
          sessionId: "s1",
          ago: 3,
        },
      ],
    });
    expect(parseRateLimitSightings(stats([{ client: null, ago: 3 }]))).toEqual({
      kind: "failed",
      reason: expect.stringMatching(
        /^the running daemon \(9\.9\.9\) reported its renders without the rate-limit windows/,
      ),
    });
  });
});

describe("the forge CLI's own word", () => {
  test("ran, absent, logged out, or could not be asked", async () => {
    const base = { stdout: "", stderr: "", exitCode: null };
    const failure = { ...base, signal: null };
    expect(forgeLoginOf("gh", "h", "logged-out", { ok: true, ...base })).toEqual(
      { kind: "ok", value: { cli: "gh", host: "h", status: "ready" } },
    );
    expect(
      forgeLoginOf("gh", "h", "logged-out", {
        ok: false,
        reason: "spawn-error",
        error: "spawn gh ENOENT",
        ...failure,
      }),
    ).toMatchObject({ value: { status: "missing" } });
    expect(
      forgeLoginOf("gh", "h", "logged-out", {
        ok: false,
        reason: "non-zero",
        ...failure,
        exitCode: 1,
        stderr: "no oauth token found for h\n",
      }),
    ).toMatchObject({
      value: { status: { loggedOut: "no oauth token found for h" } },
    });
    expect(
      forgeLoginOf("glab", "h", "failed", {
        ok: false,
        reason: "non-zero",
        ...failure,
        exitCode: 2,
        stderr: "boom\n",
      }),
    ).toEqual({ kind: "failed", reason: "glab: non-zero, exit 2, boom" });
  });
});

// The probe for real: a checkout whose origin is on github.com, and a `gh`
// on PATH that is a stub — logged in, logged out, or not there at all.
describe("the forge probe over a real checkout", () => {
  let dir: string;
  let bin: string;
  const PATH = process.env.PATH;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-forge-"));
    bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    execFileSync("git", ["init", "-q", path.join(dir, "repo")]);
    // Only the stub dir, holding a link to the system git: git's own
    // directory can hold a real gh (/usr/bin on a CI runner), so it is never
    // on PATH, and no gh but a stub can answer.
    fs.symlinkSync(
      execFileSync("which", ["git"]).toString().trim(),
      path.join(bin, "git"),
    );
    process.env.PATH = bin;
  });
  afterEach(() => {
    process.env.PATH = PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = () => path.join(dir, "repo");
  const remote = (url: string) =>
    execFileSync("git", ["-C", repo(), "remote", "add", "origin", url]);
  const gh = (script: string) => {
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\n${script}\n`, {
      mode: 0o755,
    });
  };

  test("a directory in no checkout names no forge", async () => {
    expect(await forgeLogin(processLauncher, bin)).toEqual({ kind: "ok", value: null });
  });

  test("a checkout with no forge remote names none", async () => {
    remote("/srv/git/mirror.git");
    expect(await forgeLogin(processLauncher, repo())).toEqual({ kind: "ok", value: null });
  });

  test("gh asked for the remote's own host, and logged in", async () => {
    remote("git@github.com:o/r.git");
    gh('[ "$*" = "auth token --hostname github.com" ] && echo tok || exit 3');
    expect(await forgeLogin(processLauncher, repo())).toEqual({
      kind: "ok",
      value: { cli: "gh", host: "github.com", status: "ready" },
    });
  });

  test("gh asked for github.com under an ssh-over-443 remote, as gh keys its login", async () => {
    remote("ssh://git@ssh.github.com:443/o/r.git");
    gh('[ "$*" = "auth token --hostname github.com" ] && echo tok || exit 3');
    expect(await forgeLogin(processLauncher, repo())).toEqual({
      kind: "ok",
      value: { cli: "gh", host: "github.com", status: "ready" },
    });
  });

  test("gh with no token for the host is logged out, with its line", async () => {
    remote("https://github.com/o/r.git");
    gh('echo "no oauth token found for github.com" >&2; exit 1');
    expect(await forgeLogin(processLauncher, repo())).toEqual({
      kind: "ok",
      value: {
        cli: "gh",
        host: "github.com",
        status: { loggedOut: "no oauth token found for github.com" },
      },
    });
  });

  test("no gh on PATH is missing", async () => {
    remote("https://github.com/o/r.git");
    expect(await forgeLogin(processLauncher, repo())).toMatchObject({
      kind: "ok",
      value: { status: "missing" },
    });
  });
});
