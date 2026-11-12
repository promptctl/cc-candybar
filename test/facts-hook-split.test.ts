// [LAW:behavior-not-structure] A session's facts document is gathered from its
// transcript alone, and the hook's instantaneous fields are the renderer's: two
// requests whose hooks differ only in cost, context window, durations and
// lines read one document, and compose two payloads that differ in exactly
// what those fields answer. Read over the real usage, context and metrics
// owners, the three whose answers the hook used to be laid into.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SessionUsageStore } from "../src/daemon/cache/session-usage-store";
import { assembleFacts } from "../src/daemon/facts-assembly";
import {
  composePayload,
  readingsOf,
  refreshPayload,
  settledLanes,
  type PayloadInputs,
  type RenderPayloadDeps,
} from "../src/daemon/render-payload";
import { sessionIdOf } from "../src/daemon/session-id";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import { ContextProvider } from "../src/segments/context";
import { MetricsProvider } from "../src/segments/metrics";
import { systemTimekeeper } from "../src/time";
import type { CheckedHookData } from "../src/renderer/request-context";
import { instantOf } from "../src/utils/instant";
import { ABSENT, pendingOf } from "../src/utils/outcome";
import { NO_CONFIG_FILE } from "./helpers/config-file-facts";
import { HOST } from "./helpers/host";
import { absentOwners } from "./helpers/payload-owners";
import { globalsFor } from "./helpers/selection";

const SID = sessionIdOf("hook-split");
const AT = instantOf(new Date(1_700_000_000_000));
const DRAW = {
  sources: [],
  effective: globalsFor(DEFAULT_DSL_CONFIG),
  configFacts: NO_CONFIG_FILE,
  history: EMPTY_HISTORY_DEPTH,
  back: 0,
};

// A prompt and the reply that answered it, with the reply's usage.
function transcript(path: string): void {
  writeFileSync(
    path,
    [
      {
        type: "user",
        timestamp: "2026-05-31T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "assistant",
        timestamp: "2026-05-31T00:00:04.000Z",
        requestId: "req-1",
        message: {
          id: "msg-1",
          role: "assistant",
          model: "claude-opus-4-8",
          usage: { input_tokens: 1_200, output_tokens: 300 },
        },
      },
    ]
      .map((entry) => JSON.stringify(entry) + "\n")
      .join(""),
  );
}

// One session's hook, its instantaneous fields set from `n`.
function hookAt(path: string, n: number): CheckedHookData {
  return {
    hook_event_name: "Status",
    session_id: SID,
    transcript_path: path,
    cwd: "/tmp",
    model: { id: "claude-opus-4-8", display_name: "Opus" },
    workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
    cost: {
      total_cost_usd: n,
      total_duration_ms: n * 100_000,
      total_api_duration_ms: n * 1_000,
      total_lines_added: n * 10,
      total_lines_removed: n * 3,
    },
    context_window: {
      total_input_tokens: n * 1_000,
      total_output_tokens: 0,
      context_window_size: n * 100_000,
      used_percentage: n,
      remaining_percentage: 100 - n,
      current_usage: {
        input_tokens: n * 500,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

let dir: string;
const stores: SessionUsageStore[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccb-hook-split-"));
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A request under `hookData` over owners of its own, so what one hook's
// refresh stores cannot reach the other's document.
function inputsOf(hookData: CheckedHookData): PayloadInputs {
  const usageStore = new SessionUsageStore({
    clock: systemTimekeeper,
    host: HOST,
    sweepIntervalMs: 0,
  });
  stores.push(usageStore);
  const deps = {
    ...absentOwners(),
    usageStore,
    contextProvider: new ContextProvider({ clock: systemTimekeeper }),
    metricsProvider: new MetricsProvider({ clock: systemTimekeeper }),
    log: () => {},
  } as unknown as RenderPayloadDeps;
  return { hookData, deps, cwd: "/tmp", hints: {} };
}

test("two hooks that differ only in their instantaneous fields read one document and compose two payloads", async () => {
  const path = join(dir, "t.jsonl");
  transcript(path);
  const one = inputsOf(hookAt(path, 1));
  const two = inputsOf(hookAt(path, 2));

  // Each document is its own hook's refresh and read, so a hook value either
  // one stored would show as a difference.
  const documentOf = async (inputs: PayloadInputs) => {
    await refreshPayload(inputs, AT, new Map());
    return assembleFacts(
      undefined,
      SID,
      readingsOf(inputs, settledLanes(ABSENT, { plugins: new Map(), runs: new Map() })),
      pendingOf("unread"),
      AT,
    );
  };
  const document = await documentOf(one);
  expect(await documentOf(two)).toEqual(document);
  // The folds answered: a document of pending facts would be equal too.
  expect(document.builtins.session).toMatchObject({ kind: "ok" });
  expect(document.builtins.context).toMatchObject({ kind: "ok" });
  expect(document.builtins.metrics).toMatchObject({ kind: "ok" });

  const payloadOf = (inputs: PayloadInputs) =>
    composePayload(
      document,
      {
        hookData: inputs.hookData,
        hints: inputs.hints,
        home: inputs.deps.home,
      },
      DRAW,
    );
  const first = payloadOf(one);
  const second = payloadOf(two);
  expect([first.session, second.session]).toMatchObject([
    { cost: 1 },
    { cost: 2 },
  ]);
  expect([first.context, second.context]).toEqual([
    { totalTokens: 500, contextLeft: 99 },
    { totalTokens: 1_000, contextLeft: 98 },
  ]);
  expect([first.metrics, second.metrics]).toMatchObject([
    { responseTime: 1, sessionDuration: 100, linesAdded: 10, linesRemoved: 3 },
    { responseTime: 2, sessionDuration: 200, linesAdded: 20, linesRemoved: 6 },
  ]);
  // What the transcript said is the same in both: its tokens and its turns.
  for (const payload of [first, second]) {
    expect(payload.session).toMatchObject({ tokens: 1_500 });
    expect(payload.metrics).toMatchObject({
      messageCount: 1,
      lastResponseTime: 4,
    });
  }
  // Nothing else differs but the hook's own fields as the payload spreads
  // them, and the burn rate, which is cost over duration.
  const rest = ({
    session: _session,
    context: _context,
    metrics: _metrics,
    burn: _burn,
    cost: _cost,
    context_window: _window,
    ...others
  }: typeof first) => others;
  expect(rest(first)).toEqual(rest(second));
});
