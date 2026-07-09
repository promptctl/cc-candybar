import { spawn } from "node:child_process";
import {
  readStartTime,
  readOwnStartTime,
  sameLiveProcess,
  type Launcher,
  type StartTimeRead,
} from "../src/daemon/process-fingerprint";
import { type LaunchResult } from "../src/proc/launch";

// A fake launcher yielding a fixed LaunchResult, so readStartTime's parse/branch
// logic is exercised without a real `ps`.
const launcher = (res: LaunchResult): Launcher => () => res;
const okStdout = (stdout: string): LaunchResult => ({
  ok: true,
  stdout,
  stderr: "",
  exitCode: 0,
});

// ─── readStartTime: real `ps`, injected fakes for the unavailable branches ────
//
// [LAW:behavior-not-structure] The live/dead cases run against the REAL `ps` so
// the test proves the actual interface (a live pid lists; a dead pid does not),
// not a mocked stand-in. The `unavailable` branch (no `ps`, ambiguous failure)
// is deterministically driven by an injected exec — there is no portable way to
// make the real `ps` vanish mid-test.

describe("readStartTime (real ps)", () => {
  test("our own live pid → start with a non-empty token", () => {
    const r = readStartTime(process.pid);
    expect(r.kind).toBe("start");
    if (r.kind === "start") expect(r.token.length).toBeGreaterThan(0);
  });

  test("a dead pid → gone (ps lists no such process)", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid: number = await new Promise((resolve) => {
      child.once("exit", () => resolve(child.pid as number));
    });
    expect(readStartTime(deadPid).kind).toBe("gone");
  });
});

describe("readStartTime (injected launcher — the unavailable branches)", () => {
  const fail = (
    reason: Extract<LaunchResult, { ok: false }>["reason"],
    stdout: string,
    exitCode: number | null = 1,
  ): LaunchResult => ({
    ok: false,
    reason,
    stdout,
    stderr: "",
    exitCode,
    signal: null,
  });

  test("ps binary missing (spawn-error) → unavailable, NOT gone", () => {
    expect(
      readStartTime(123, launcher(fail("spawn-error", "", null))).kind,
    ).toBe("unavailable");
  });

  // A clean non-zero exit with EMPTY stdout is ps's confirmed "no such process".
  test("non-zero exit + empty stdout → gone", () => {
    expect(readStartTime(123, launcher(fail("non-zero", ""))).kind).toBe(
      "gone",
    );
  });

  // A non-zero exit that still produced output is ambiguous — we must NOT read
  // it as a dead process (that could steal a live socket); degrade to
  // unavailable so the caller falls back to kill(pid,0).
  test("non-zero exit + non-empty stdout → unavailable (ambiguous, not gone)", () => {
    expect(
      readStartTime(123, launcher(fail("non-zero", "Mon Jan  1 00:00:00 2024")))
        .kind,
    ).toBe("unavailable");
  });

  test("timeout → unavailable (cannot determine liveness)", () => {
    expect(readStartTime(123, launcher(fail("timeout", ""))).kind).toBe(
      "unavailable",
    );
  });

  // Exit 0 with empty output is anomalous — treat as gone rather than minting an
  // empty-string fingerprint that would spuriously match another empty read.
  test("exit 0 + empty stdout → gone (no empty-string fingerprint)", () => {
    expect(readStartTime(123, launcher(okStdout("  \n"))).kind).toBe("gone");
  });
});

// ─── sameLiveProcess: the pure liveness fold ──────────────────────────────────

describe("sameLiveProcess (pure fold over injected reads)", () => {
  const deps = (
    read: StartTimeRead,
    alive: boolean,
  ): Parameters<typeof sameLiveProcess>[2] & { pidAliveCalls: number } => {
    const d = {
      pidAliveCalls: 0,
      readStartTime: () => read,
      pidAlive: () => {
        d.pidAliveCalls++;
        return alive;
      },
    };
    return d;
  };

  test("start + token matches lease → true (same process alive)", () => {
    const d = deps({ kind: "start", token: "T" }, false);
    expect(sameLiveProcess(10, "T", d)).toBe(true);
    expect(d.pidAliveCalls).toBe(0); // fingerprint decided; no fallback
  });

  test("start + token differs → false (recycled / restarted process)", () => {
    const d = deps({ kind: "start", token: "OTHER" }, true);
    expect(sameLiveProcess(10, "T", d)).toBe(false);
    expect(d.pidAliveCalls).toBe(0);
  });

  test("gone → false (no live process)", () => {
    expect(sameLiveProcess(10, "T", deps({ kind: "gone" }, true))).toBe(false);
  });

  test("unavailable → falls back to kill(pid,0)", () => {
    expect(
      sameLiveProcess(10, "T", deps({ kind: "unavailable", detail: "x" }, true)),
    ).toBe(true);
    expect(
      sameLiveProcess(
        10,
        "T",
        deps({ kind: "unavailable", detail: "x" }, false),
      ),
    ).toBe(false);
  });

  // A null lease token (the writer could not fingerprint) must NOT consult the
  // start-time at all — fall straight back to kill(pid,0), preserving .1's
  // theft protection on a host without `ps`.
  test("null lease token → kill(pid,0) fallback without reading start-time", () => {
    const read = jest.fn<StartTimeRead, [number]>(() => ({ kind: "gone" }));
    const d = { readStartTime: read, pidAlive: () => true };
    expect(sameLiveProcess(10, null, d)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("readOwnStartTime", () => {
  test("our own pid → a non-null token", () => {
    expect(readOwnStartTime(process.pid)).not.toBeNull();
  });

  test("unavailable read → null (unfingerprinted lease)", () => {
    expect(
      readOwnStartTime(process.pid, () => ({
        kind: "unavailable",
        detail: "no ps",
      })),
    ).toBeNull();
  });

  test("start read → the token", () => {
    expect(
      readOwnStartTime(1, () => ({ kind: "start", token: "TOK" })),
    ).toBe("TOK");
  });
});
