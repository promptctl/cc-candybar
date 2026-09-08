import { spawn } from "node:child_process";
import {
  readStartTime,
  readOwnStartTime,
  sameLiveProcess,
  type Launcher,
  type StartTimeRead,
} from "../src/daemon/process-fingerprint";
import { type LaunchResult } from "../src/proc/launch";

const launcher = (res: LaunchResult): Launcher => () => res;
const okStdout = (stdout: string): LaunchResult => ({
  ok: true,
  stdout,
  stderr: "",
  exitCode: 0,
});

// [LAW:behavior-not-structure] The live/dead cases run against the REAL `ps`; only the unavailable branch is injected.

describe("readStartTime (real ps)", () => {
  test("our own live pid → start with a non-empty token", () => {
    const r = readStartTime(process.pid);
    expect(r.kind).toBe("start");
    if (r.kind === "start") expect(r.token.length).toBeGreaterThan(0);
  });

  // A dead pid yields no start-time row → `unavailable`, not a `gone` claim ps cannot make.
  test("a dead pid → unavailable (ps reports no start-time)", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid: number = await new Promise((resolve) => {
      child.once("exit", () => resolve(child.pid as number));
    });
    expect(readStartTime(deadPid).kind).toBe("unavailable");
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

  // [FRAMING:representation] The token is a sound equality key only if ps renders it deterministically.
  test("pins LC_ALL=C and TZ=UTC on the ps subprocess (locale- and tz-independent token)", () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const capture: Launcher = (opts) => {
      seenEnv = opts.env;
      return okStdout("Thu Jul  9 05:04:25 2026");
    };
    readStartTime(123, capture);
    expect(seenEnv?.LC_ALL).toBe("C");
    expect(seenEnv?.TZ).toBe("UTC");
  });

  test("ps binary missing (spawn-error) → unavailable", () => {
    expect(
      readStartTime(123, launcher(fail("spawn-error", "", null))).kind,
    ).toBe("unavailable");
  });

  // A non-zero exit cannot distinguish "no such process" from "cannot read it", so never false-dead.
  test("non-zero exit + empty stdout → unavailable (could be an access failure, not death)", () => {
    expect(readStartTime(123, launcher(fail("non-zero", ""))).kind).toBe(
      "unavailable",
    );
  });

  test("non-zero exit + non-empty stdout → unavailable", () => {
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

  test("exit 0 + empty stdout → unavailable (no empty-string fingerprint)", () => {
    expect(readStartTime(123, launcher(okStdout("  \n"))).kind).toBe(
      "unavailable",
    );
  });
});

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

  test("null lease token → kill(pid,0) fallback without reading start-time", () => {
    const read = jest.fn<StartTimeRead, [number]>(() => ({
      kind: "unavailable",
      detail: "unused",
    }));
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
