// The page's transport on GitHub Pages: the daemon runs in this page.
//
// [LAW:single-enforcer] A render and a click are the daemon's own request
// handler (src/daemon/server.ts `handleRequest`), sent the request the Rust
// client and the URL handler send. Nothing here renders: the daemon reads the
// simulated machine (world.ts) through node:fs and node:child_process, as it
// reads a real one, and the scenario (scenario.ts) moves that machine.

import { handleRequest } from "../src/daemon/server";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { parseHandlerUrl } from "../src/install/index";
import { describeLink, drawnLinks } from "../test/helpers/bar-links";
import { effectsOf } from "../test/helpers/click";
import { DURATION, INITIAL_MOMENT, INITIAL_REPO, STEPS, type Entry, type Moment, type Step } from "./scenario";
import { CLAUDE_DIR, REPO, appendTranscript, forgetConfig, newTranscript, seedWorld, updateRepo } from "./world";

// The page's clipboard (this file is checked against Node's types, which have no `navigator`).
declare const navigator: { readonly clipboard: { writeText(text: string): Promise<void> } };

interface Size {
  readonly width: number;
  readonly rows: number;
}

const CONTEXT_WINDOW = 200_000;
const TICK_MS = 250;
const PAUSE_AT_END_MS = 6000;

seedWorld(INITIAL_REPO);

// ── The session: its id, transcript, the hook's numbers, and the scenario clock ──
let sessionId = "";
let transcript = "";
let moment: Required<Moment> = INITIAL_MOMENT;
let applied = 0; // how many STEPS have happened
let t = 0; // scenario seconds
let wallStart = Date.now(); // the wall time of t = 0
let speed = 1;
let playing = true;
let serial = 0;

const stamp = (): string => new Date(wallStart + t * 1000).toISOString();
const id = (prefix: string): string => `${prefix}_${(serial++).toString(36)}`;

function lines(entry: Entry): object[] {
  const base = { timestamp: stamp(), sessionId, cwd: REPO, isSidechain: false, uuid: id("u") };
  const usage = (output: number) => ({
    input_tokens: 4,
    output_tokens: output,
    cache_creation_input_tokens: 800,
    cache_read_input_tokens: moment.context,
  });
  const assistant = (content: object[], output: number) => ({
    ...base,
    type: "assistant",
    requestId: id("req"),
    message: { id: id("msg"), model: "claude-opus-4-8", role: "assistant", type: "message", content, usage: usage(output) },
  });
  switch (entry.kind) {
    case "user":
      return [{ ...base, type: "user", message: { role: "user", content: entry.text } }];
    case "command":
      return [{ ...base, type: "user", message: { role: "user",
        content: `<command-name>${entry.name}</command-name>\n<command-message>${entry.name.slice(1)}</command-message>\n<command-args></command-args>` } }];
    case "tools":
      return [assistant(entry.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} })), entry.output ?? 100)];
    case "results":
      return [{ ...base, type: "user", message: { role: "user",
        content: entry.ids.map((tool_use_id) => ({ type: "tool_result", tool_use_id, content: "ok" })) } }];
    case "reply":
      return [assistant([{ type: "text", text: entry.text }], entry.output ?? 200)];
  }
}

function happen(step: Step): void {
  moment = { ...moment, ...step.hook };
  if (step.repo) updateRepo(step.repo);
  appendTranscript(transcript, (step.transcript ?? []).flatMap(lines));
}

/** Start a session with the scenario at `seconds`: everything before it has happened. */
function startAt(seconds: number): void {
  sessionId = crypto.randomUUID();
  transcript = newTranscript(sessionId);
  moment = INITIAL_MOMENT;
  applied = 0;
  updateRepo(INITIAL_REPO);
  t = seconds;
  wallStart = Date.now() - seconds * 1000;
  while (applied < STEPS.length && STEPS[applied]!.at <= t) happen(STEPS[applied++]!);
}

function hookData() {
  const now = Math.floor(Date.now() / 1000);
  const used = Math.round((moment.context / CONTEXT_WINDOW) * 100);
  return {
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: transcript,
    cwd: REPO,
    version: "2.1.0",
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    workspace: { current_dir: REPO, project_dir: REPO, added_dirs: [] },
    cost: {
      total_cost_usd: moment.costUsd,
      total_duration_ms: t * 1000,
      total_api_duration_ms: t * 600,
      total_lines_added: moment.linesAdded,
      total_lines_removed: moment.linesRemoved,
    },
    context_window: {
      total_input_tokens: moment.context,
      total_output_tokens: 4000,
      context_window_size: CONTEXT_WINDOW,
      used_percentage: used,
      remaining_percentage: 100 - used,
      current_usage: { input_tokens: 2000, output_tokens: 400, cache_creation_input_tokens: 4000, cache_read_input_tokens: moment.context - 6000 },
    },
    rate_limits: {
      five_hour: { used_percentage: moment.fiveHour, resets_at: now + 2 * 3600 + 17 * 60 },
      seven_day: { used_percentage: moment.sevenDay, resets_at: now + 4 * 86400 },
    },
  };
}

async function daemon(request: object): Promise<string> {
  const { resp } = await handleRequest({ v: PROTOCOL_VERSION, ...request } as never);
  if (!resp.ok) throw new Error(`${resp.error} (${resp.code})`);
  return "output" in resp ? resp.output : "";
}

async function render(size: Size) {
  const ansi = await daemon({
    kind: "render",
    hookData: hookData(),
    args: ["cc-candybar"],
    cwd: REPO,
    termCols: size.width,
    termRows: size.rows,
    ssh: false,
    claudeConfigDir: CLAUDE_DIR,
  });
  return { ansi, links: drawnLinks(ansi).map((l) => ({ ...l, does: describeLink(l, sessionId) })), refused: null as string | null };
}

// What the page does in place of a click that reaches outside the bar on a real
// machine: a copy is the page's own clipboard; the rest cannot happen here.
const ELSEWHERE: Readonly<Record<string, string>> = {
  "open-vscode": "opens a file in VS Code on a real machine",
  "apply-update": "rebuilds cc-candybar on a real machine",
  "show-config-error": "copies the error on a real machine",
  "show-config-warning": "copies the warning on a real machine",
};

async function click(url: string, size: Size) {
  const effects = effectsOf(url);
  const copy = effects.find((e) => e.verb === "copy");
  const elsewhere = effects.find((e) => ELSEWHERE[e.verb] !== undefined);
  if (copy !== undefined) {
    const text = copy.args[copy.args.length - 1] ?? "";
    await navigator.clipboard.writeText(text).catch(() => undefined);
    return { ...(await render(size)), refused: `copied to your clipboard: ${text}` };
  }
  if (elsewhere !== undefined) return { ...(await render(size)), refused: `not here: this ${ELSEWHERE[elsewhere.verb]}` };
  const { verb, value } = parseHandlerUrl(url);
  let refused: string | null = null;
  try {
    await daemon({ kind: "click", verb, value });
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  return { ...(await render(size)), refused };
}

// ── The player ──
type Listener = (state: { index: number; playing: boolean; progress: number }) => void;
const listeners: Listener[] = [];
const notify = (): void => {
  const state = { index: Math.max(0, applied - 1), playing, progress: Math.min(1, t / DURATION) };
  for (const l of listeners) l(state);
};

let lastNotified = 0;
let endedAt: number | null = null;
setInterval(() => {
  if (!playing) return;
  if (t >= DURATION) {
    // Hold the last frame, then go round again.
    endedAt ??= Date.now();
    if (Date.now() - endedAt < PAUSE_AT_END_MS) return;
    endedAt = null;
    startAt(0);
    notify();
    return;
  }
  t = Math.min(DURATION, t + (TICK_MS / 1000) * speed);
  const before = applied;
  while (applied < STEPS.length && STEPS[applied]!.at <= t) happen(STEPS[applied++]!);
  // A step is drawn at once; between steps the clocks the bar shows still move, so redraw each second.
  if (applied !== before || Date.now() - lastNotified > 1000) {
    lastNotified = Date.now();
    notify();
  }
}, TICK_MS);

startAt(0);

export const transport = {
  about:
    'This is <a href="https://github.com/promptctl/cc-candybar">cc-candybar</a>\'s own daemon, compiled for the browser and running in this page against a simulated machine. ' +
    "The bar replays a few turns of a Claude Code session. Every click is real: open the 🍫 menu, switch themes, arrange segments.",
  render,
  click,
  restart: async (size: Size) => {
    forgetConfig();
    startAt(t);
    notify();
    return render(size);
  },
  scenario: {
    steps: STEPS.map((s) => ({ turn: s.turn, caption: s.caption, at: s.at / DURATION })),
    subscribe: (l: Listener) => {
      listeners.push(l);
      notify();
    },
    playing: () => playing,
    play: () => {
      playing = true;
      notify();
    },
    pause: () => {
      playing = false;
      notify();
    },
    replay: () => {
      startAt(0);
      playing = true;
      notify();
    },
    seek: (fraction: number) => {
      startAt(fraction * DURATION);
      notify();
    },
    setSpeed: (n: number) => {
      speed = n;
    },
  },
};
