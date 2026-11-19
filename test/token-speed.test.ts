// Token-speed segment (brandon-usage-cob). Four layers, same shape as the
// burn-rate ticket it builds on:
//   1. the pure projection math (projectTokensPerSecond),
//   2. the SessionUsageStore keeping each session's ring of samples — the
//      single owner of per-session totals, no parallel counter — each saying
//      whether its turn was open,
//   3. speedPayloadOf folding the ring into speed.{in,out,total,history},
//   4. the speed segment formatting it — including the "—" absence path.
//
// [LAW:no-silent-failure] The headline assertion across all layers: no turn
// open, or idle time between turns, yields ABSENCE (missing field → -1
// default → "—"), never a stale or divide-by-zero number.

import { textOf } from "../src/render/frame";
import { HOST } from "./helpers/host";
import { unscriptedRuns } from "./helpers/fake-launcher";
import { drawPayload } from "./helpers/draw-payload";
import type { Frame } from "../src/render/frame";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectTokensPerSecond,
  speedPayloadOf,
} from "../src/renderer/render-payload";
import { SessionUsageStore } from "../src/daemon/cache/session-usage-store";
import { turnOpenAfter, type ParsedEntry } from "../src/utils/claude";
import type { SpeedSample } from "../src/facts/world-state";
import { validateConfig } from "./helpers/parse-and-validate";
import { mergeWithDefault, parseDslConfig } from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { registerDslConfig } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/renderer/session-state";
import { instantOf } from "../src/utils/instant";
import { systemTimekeeper } from "../src/time";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const S_2 = sessionIdOf("S");
const C_2 = sessionIdOf("C");
const R_2 = sessionIdOf("R");
const O_2 = sessionIdOf("O");
const U_2 = sessionIdOf("U");
const T_2 = sessionIdOf("T");

// ─── projectTokensPerSecond (pure) ───────────────────────────────────────────

describe("projectTokensPerSecond (pure)", () => {
  test("500 tokens over 1s → 500 tok/s", () => {
    expect(projectTokensPerSecond(1000, 0, 1500, 1000)).toBe(500);
  });

  test("idle: count did not advance → undefined (not 0)", () => {
    expect(projectTokensPerSecond(1000, 0, 1000, 1000)).toBeUndefined();
  });

  test("count went backwards (impossible cumulative) → undefined", () => {
    expect(projectTokensPerSecond(1000, 0, 900, 1000)).toBeUndefined();
  });

  test("window under the floor (clock barely moved) → undefined", () => {
    expect(projectTokensPerSecond(1000, 0, 1500, 10)).toBeUndefined();
  });

  test("a long interval is still a rate: idle time is the turn's to rule out", () => {
    expect(projectTokensPerSecond(1000, 0, 4000, 30_000)).toBe(100);
  });
});

// ─── SessionUsageStore speed (the sample ring's owner) ────────────────────────

function usageLine(
  tag: string,
  input: number,
  output: number,
  stopReason?: string,
): string {
  return (
    JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: `req-${tag}`,
      costUSD: 0.01,
      ...(stopReason !== undefined && { type: "assistant" }),
      message: {
        id: `msg-${tag}`,
        model: "claude-opus-4-8",
        usage: { input_tokens: input, output_tokens: output },
        ...(stopReason !== undefined && { stop_reason: stopReason }),
      },
    }) + "\n"
  );
}

function promptLine(): string {
  return (
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "user",
      message: { role: "user", content: "go" },
    }) + "\n"
  );
}

describe("turnOpenAfter — an assistant message's stop", () => {
  const assistant = (stopReason?: string): ParsedEntry => ({
    timestamp: new Date(0),
    type: "assistant",
    message: { stopReason },
    raw: {},
  });

  test("a tool call, a paused turn and a block still streaming keep the turn open", () => {
    for (const reason of [undefined, "tool_use", "pause_turn"]) {
      expect(turnOpenAfter(true, assistant(reason))).toBe(true);
    }
  });

  test("any other stop ends the turn, one the API adds later included", () => {
    for (const reason of [
      "end_turn",
      "max_tokens",
      "stop_sequence",
      "refusal",
      "model_context_window_exceeded",
      "a_reason_added_later",
    ]) {
      expect(turnOpenAfter(true, assistant(reason))).toBe(false);
    }
  });
});

describe("SessionUsageStore speed — the sample ring", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-speed-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a first observation is the ring's one sample; the next write appends to it", async () => {
    const t = join(dir, "S.jsonl");
    writeFileSync(t, usageLine("a", 10, 5));
    utimesSync(t, new Date(1000), new Date(1000));
    const store = new SessionUsageStore({
      clock: systemTimekeeper,
      host: HOST,
      sweepIntervalMs: 0,
    });
    try {
      const first = await store.refresh(S_2, t, "change").speed(1_000);
      if (first.kind !== "ok") throw new Error("no observation");
      // input folds the cache lanes (here zero) onto raw input; total = in + out.
      expect(first.value.samples).toEqual([
        { input: 10, output: 5, total: 15, atMs: 1_000, turnOpen: false },
      ]);

      // Transcript grows by one more turn; bump mtime so the store re-parses.
      writeFileSync(t, usageLine("a", 10, 5) + usageLine("b", 10, 5));
      utimesSync(t, new Date(2000), new Date(2000));
      const second = await store.refresh(S_2, t, "change").speed(2_000);
      if (second.kind !== "ok") throw new Error("no observation");
      expect(second.value.samples).toMatchObject([
        { input: 10, output: 5, atMs: 1_000 },
        { input: 20, output: 10, atMs: 2_000 },
      ]);
    } finally {
      store.close();
    }
  });

  // [LAW:one-source-of-truth] Whether Claude is working is read from the
  // transcript itself, so the rate ends at the write that ends the turn.
  test("a sample says whether its turn is open: a prompt opens it, a tool call keeps it, a final message closes it", async () => {
    const t = join(dir, "T.jsonl");
    const store = new SessionUsageStore({
      clock: systemTimekeeper,
      host: HOST,
      sweepIntervalMs: 0,
    });
    try {
      const writes = [
        promptLine(),
        usageLine("call", 10, 5, "tool_use"),
        usageLine("done", 10, 5, "end_turn"),
      ];
      const open: boolean[] = [];
      for (let i = 0; i < writes.length; i++) {
        writeFileSync(t, writes.slice(0, i + 1).join(""));
        const ms = (i + 1) * 1000;
        utimesSync(t, new Date(ms), new Date(ms));
        const r = await store.refresh(T_2, t, "change").speed(ms);
        if (r.kind !== "ok") throw new Error("no observation");
        open.push(r.value.samples.at(-1)!.turnOpen);
      }
      expect(open).toEqual([true, true, false]);
    } finally {
      store.close();
    }
  });

  // The backstop period reads a quiet transcript again and again; a sample
  // per read would fill the ring with idle pairs and push the turn that did
  // work out of the burn-rate history.
  test("a read over an unchanged transcript takes no sample: it answers the standing observation", async () => {
    const t = join(dir, "U.jsonl");
    writeFileSync(t, usageLine("a", 10, 5));
    utimesSync(t, new Date(1000), new Date(1000));
    const store = new SessionUsageStore({
      clock: systemTimekeeper,
      host: HOST,
      sweepIntervalMs: 0,
    });
    try {
      const first = await store.refresh(U_2, t, "first").speed(1_000);
      const again = await store.refresh(U_2, t, "period").speed(11_000);
      expect(again).toBe(first);
      if (again.kind !== "ok") throw new Error("no observation");
      expect(again.value.samples.map((s) => s.atMs)).toEqual([1_000]);
    } finally {
      store.close();
    }
  });

  test("concurrent same-state observations coalesce to ONE sample", async () => {
    const t = join(dir, "C.jsonl");
    writeFileSync(t, usageLine("a", 10, 5));
    utimesSync(t, new Date(1000), new Date(1000));
    const store = new SessionUsageStore({
      clock: systemTimekeeper,
      host: HOST,
      sweepIntervalMs: 0,
    });
    try {
      // Establish a baseline (output 5) at the first transcript state.
      await store.refresh(C_2, t, "change").speed(1_000);

      // Output grows to 25; bump mtime to the new state.
      writeFileSync(t, usageLine("a", 10, 5) + usageLine("b", 10, 20));
      utimesSync(t, new Date(2000), new Date(2000));

      // Two refreshes observe the SAME new state concurrently. Without the
      // single-flight, each would append its own sample of it, and the pair
      // between them would read as a flat interval. Coalesced, both share ONE
      // observation, whose ring holds the baseline (5) and the new state (25).
      const [a, b] = await Promise.all([
        store.refresh(C_2, t, "change").speed(2_000),
        store.refresh(C_2, t, "change").speed(2_000),
      ]);
      expect(b).toBe(a);
      if (a.kind !== "ok") throw new Error("no observation");
      expect(a.value.samples.map((s) => s.output)).toEqual([5, 25]);
    } finally {
      store.close();
    }
  });

  test("the ring accumulates recent samples oldest→newest", async () => {
    const t = join(dir, "R.jsonl");
    const store = new SessionUsageStore({
      clock: systemTimekeeper,
      host: HOST,
      sweepIntervalMs: 0,
    });
    try {
      // Three growing transcript states, each a distinct mtime ⇒ a new sample.
      let lines = "";
      const outputs = [5, 12, 30];
      const results = [];
      for (let i = 0; i < outputs.length; i++) {
        lines += usageLine(`t${i}`, 10, outputs[i]! - (outputs[i - 1] ?? 0));
        const ms = (i + 1) * 1000;
        writeFileSync(t, lines);
        utimesSync(t, new Date(ms), new Date(ms));
        const r = await store.refresh(R_2, t, "change").speed(ms);
        expect(r.kind).toBe("ok");
        if (r.kind !== "ok") return;
        results.push(r.value);
      }
      // The ring grows by one each observation, ordered oldest→newest.
      expect(results.map((r) => r.samples.length)).toEqual([1, 2, 3]);
      const last = results[2]!;
      expect(last.samples.map((s) => s.atMs)).toEqual([1000, 2000, 3000]);
    } finally {
      store.close();
    }
  });

  test("ring order follows observation time, not insertion order", async () => {
    // [LAW:no-ambient-temporal-coupling] Regression for the concurrency hazard:
    // two non-coalesced observes (distinct mtimes) can reach the ring mutation in
    // ingest-completion order. Here the second observe carries an EARLIER render
    // clock (atMs 1000) than the first (atMs 3000) — simulating that inversion —
    // and the ring must still come back sorted oldest→newest by atMs, not by the
    // order the samples were inserted.
    const t = join(dir, "O.jsonl");
    const store = new SessionUsageStore({
      clock: systemTimekeeper,
      host: HOST,
      sweepIntervalMs: 0,
    });
    try {
      writeFileSync(t, usageLine("a", 10, 5));
      utimesSync(t, new Date(1000), new Date(1000));
      const first = await store.refresh(O_2, t, "change").speed(3_000); // inserted first, atMs 3000
      expect(first.kind).toBe("ok");

      writeFileSync(t, usageLine("a", 10, 5) + usageLine("b", 10, 5));
      utimesSync(t, new Date(2000), new Date(2000));
      const second = await store.refresh(O_2, t, "change").speed(1_000); // inserted second, atMs 1000
      expect(second.kind).toBe("ok");
      if (second.kind !== "ok") return;

      // Sorted by atMs despite reverse insertion order.
      expect(second.value.samples.map((s) => s.atMs)).toEqual([1000, 3000]);
    } finally {
      store.close();
    }
  });
});

// ─── speedPayloadOf — the ring's projection ──────────────────────────────────

const sample = (
  output: number,
  atMs: number,
  turnOpen = true,
): SpeedSample => ({
  input: 1000,
  output,
  total: 1000 + output,
  atMs,
  turnOpen,
});

describe("speedPayloadOf — the ring's projection", () => {
  test("projectable: output/total rates land; idle input lane is absent", () => {
    const samples = [sample(1000, 0), sample(1500, 1000)];
    // Δoutput 500 / 1s = 500; Δtotal 500 / 1s = 500; Δinput 0 ⇒ absent.
    expect(speedPayloadOf({ samples })).toEqual({
      output: 500,
      total: 500,
      history: "500",
    });
  });

  test("a long generation is one rate, however far apart its writes", () => {
    const samples = [sample(0, 0), sample(3000, 30_000)];
    expect(speedPayloadOf({ samples })).toMatchObject({ total: 100 });
  });

  test("the rate ends at the write that closes the turn, and its history stays", () => {
    const samples = [sample(1000, 0), sample(1500, 1000, false)];
    expect(speedPayloadOf({ samples })).toEqual({ history: "500" });
  });

  test("while a tool runs, the turn shows its last measured rate and the history a 0", () => {
    // A tool call written at 1 s, its answer a minute later carries no tokens.
    const samples = [sample(0, 0), sample(500, 1000), sample(500, 61_000)];
    expect(speedPayloadOf({ samples })).toEqual({
      output: 500,
      total: 500,
      history: "500,0",
    });
  });

  test("idle time between turns is no interval: no bar, and no rate from the last turn", () => {
    const samples = [
      sample(0, 0),
      sample(100, 1000, false), // the turn ends
      sample(100, 600_000), // the next prompt, ten minutes later
    ];
    expect(speedPayloadOf({ samples })).toEqual({ history: "100" });
    // Once the new turn writes, its own interval is the rate.
    expect(
      speedPayloadOf({ samples: [...samples, sample(400, 601_000)] }),
    ).toEqual({ output: 300, total: 300, history: "100,300" });
  });

  test("first sample ⇒ no speed key, never a fabricated rate", () => {
    expect(speedPayloadOf({ samples: [sample(5, 1000)] })).toBeUndefined();
  });

  test("history skips samples too close to time instead of fabricating a 0 bar", () => {
    const samples = [sample(0, 0), sample(100, 1000), sample(110, 1005)];
    expect(speedPayloadOf({ samples })).toEqual({
      output: 100,
      total: 100,
      history: "100",
    });
  });
});

// ─── speed segment render ─────────────────────────────────────────────────────

const ALLOWED = new Set(listResolvablePaletteNames());

function renderSpeed(payload: Record<string, unknown>): Frame {
  const raw = parseDslConfig("<test>", `{ root: { h: ["speed"] } }`, ALLOWED);
  const cfg = validateConfig(
    { config: mergeWithDefault(raw, DEFAULT_DSL_CONFIG), raw, source: "{}" },
    "<test>",
    ALLOWED,
  );
  const store = new VariableStore(systemTimekeeper);
  // The settings menu references `edit.toggle`, so `edit.mode` — a `state` var — is now
  // declared regardless of this file's narrowed `speed`-only root; a
  // SessionState is required to declare it (matching every other
  // DEFAULT_DSL_CONFIG-based render helper) or it silently fails to declare
  // and speed's own `when` renders an unrelated ⚠ error cell.
  const registry = new SourceRegistry(store, "", new SessionState());
  try {
    const compiled = registerDslConfig(cfg, registry, {
      cwd: "/tmp",
    });
    return drawPayload(
      cfg,
      compiled,
      store,
      registry,
      payload,
      instantOf(new Date()),
      {
        endcaps: "powerline",
        colorCompatibility: "none",
        wrap: true,
        padding: 0,
        width: Number.POSITIVE_INFINITY,
      },
    ).frame;
  } finally {
    registry.dispose();
  }
}

const SEG_BASE = {
  hook_event_name: "Status",
  session_id: "seg-test",
  cwd: "/tmp",
  model: { id: "x", display_name: "x" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
};

describe("speed segment render", () => {
  test("live lanes format as 'N/s' (K-scaled); idle lane reads '—'", () => {
    const line = renderSpeed({
      ...SEG_BASE,
      session: { tokens: 1500 },
      speed: { output: 1500, total: 1500 }, // input absent ⇒ -1 ⇒ "—"
    });
    expect(textOf(line)).toContain("1.5K/s"); // formatTokenCount K-scaling
    expect(textOf(line)).toContain("out");
    expect(textOf(line)).toContain("in —");
    expect(textOf(line)).toContain("tot");
  });

  test("all lanes absent render '—' (the -1 default), never a fake number", () => {
    const line = renderSpeed({ ...SEG_BASE, session: { tokens: 1500 } });
    expect(textOf(line)).toContain("—");
    expect(textOf(line)).not.toMatch(/\d\/s/); // no tok/s figure anywhere
  });

  test("hidden when the session has done no work (tokens 0)", () => {
    const line = renderSpeed({ ...SEG_BASE });
    // The bar is never empty — every rendered bar carries the global settings
    // menu (candybar-settings-ui-aok.1) — so hidden is asserted as "none of
    // this segment's own content", not as an empty line.
    expect(textOf(line)).not.toContain("/s");
    expect(textOf(line)).not.toContain("tot");
  });
});
