// The tmux status line lane (lane C, candybar-animation-wbxz.oy3.w5t): the
// daemon draws a session's bar in the tmux status line that shows its pane,
// at the rate the daemon pushes its frames.
//
// A status line belongs to a tmux SESSION, which any number of Claude Code
// panes can share, and the click binding its ranges need belongs to the whole
// tmux SERVER. So the daemon is the one writer of both: it follows each
// switched-on session's frames as a subscriber of its own (FrameFeeds), and
// writes, for each tmux session, the rows of whichever held pane its status
// line shows — the client's current pane, read off the answers PaneVisibility
// already gets once a second. Everything it writes it puts back when its last
// pane there is released, and on the daemon's shutdown — but only where tmux
// still reads as the daemon left it: a value the user has set since is theirs.
//
// What the daemon wrote and what was there before live in tmux itself
// (`@cc-candybar-status-prior`, `@cc-candybar-status-wrote`,
// `@cc-candybar-binding-prior`), so a daemon that died without restoring
// leaves them for the next one, which puts them back on its first answer from
// that server. Each record names the daemon that wrote it — its socket — and
// a daemon takes over only its own: one on another socket (a dev or test
// daemon) on the same tmux server leaves what the other draws alone.
//
// [LAW:no-ambient-temporal-coupling] A tmux call costs ~20 ms of spawn
// (measured, macOS), so while the daemon runs every call is asynchronous and
// one server's calls run one at a time, in the order the reconcile decides
// them. The daemon's shutdown cannot wait (it is SIGKILLed 500 ms after it
// starts), so it restores synchronously, from the same plans — and a frame's
// write still in flight cannot undo that restore: every draw runs under
// `if-shell -F '#{@cc-candybar-status-prior}'`, which the restore removes, so
// a draw landing after it does nothing.

import { LANES } from "../config/lanes.js";
import type { TmuxRun } from "../proc/tmux.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { StatusLines } from "./pane-visibility.js";
import type { Subscriber } from "./frame-feed.js";
import {
  decodeSegments,
  encodeSegments,
  VERB_TMUX_STATUS_CLICK,
} from "../click/wire.js";
import { laneEncoded } from "../render/frame.js";
import {
  RANGE_PREFIX,
  tmuxStatusFrame,
  type TmuxStatusBar,
} from "../tmux-status/frames.js";

export const MAX_STATUS_ROWS = LANES.tmuxStatus.rows;
export const PRIOR_OPTION = "@cc-candybar-status-prior";
export const WROTE_OPTION = "@cc-candybar-status-wrote";
export const BINDING_OPTION = "@cc-candybar-binding-prior";
const CLICK_KEY = ["-T", "root", "MouseDown1Status"] as const;
const INDICES = Array.from({ length: MAX_STATUS_ROWS }, (_, i) => i);

export const rowOption = (row: number): string => `@cc-candybar-row-${row}`;
// The status row drawing a bar row: the bar row's runs, on the terminal's own
// ground past their end rather than the status line's style.
export const rowFormat = (row: number): string =>
  `#[fill=terminal]#{${rowOption(row)}}`;
const formatOption = (index: number): string => `status-format[${index}]`;

// tmux's word for a status line `rows` tall.
export function statusWord(rows: number): string {
  return rows === 0 ? "off" : rows === 1 ? "on" : String(rows);
}

// [LAW:parse-dont-validate] tmux's `status`, as rows.
export function statusRows(word: string): number {
  const rows =
    word === "off" ? 0 : word === "on" ? 1 : /^[2-5]$/.test(word) ? +word : NaN;
  if (Number.isNaN(rows))
    throw new Error(`tmux status is ${JSON.stringify(word)}`);
  return rows;
}

// A session's own `status-format`, index by index. tmux keeps an array option
// whole at each level: a session that sets any index stops reading the global
// array at every index (measured, tmux 3.6a — the window list on row 0 goes
// blank), and unsetting its indices one by one leaves an empty array that
// still shadows the global one. So the session's array is one value: read,
// written and put back whole.
export type Formats = Readonly<Record<number, string>>;

// What a tmux session's status line held at the session level before the
// daemon laid it out — its `status`, and its own `status-format` (null where
// it set neither, and read the global ones) — and the whole `status-format`
// the daemon wrote over it: the rows below the bar's copied from the array it
// read, the bar's own rows after them. `owner` is the socket of the daemon
// that laid it out.
export interface Prior {
  readonly owner: string;
  readonly base: number;
  readonly status: string | null;
  readonly formats: Formats | null;
  readonly wrote: Formats;
}

function sameFormats(a: Formats | null, b: Formats): boolean {
  if (a === null) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => a[Number(k)] === b[Number(k)])
  );
}

// tmux reads an argument ending in `;` as the end of a command (measured,
// tmux 3.6a), and `\;` as a `;` it keeps.
export function tmuxArg(value: string): string {
  return value.endsWith(";") ? `${value.slice(0, -1)}\\;` : value;
}

type Command = readonly string[];

// Commands run in one tmux invocation, `;` between them.
function chain(commands: readonly Command[]): string[] {
  return commands.flatMap((command, i) => [
    ...(i === 0 ? [] : [";"]),
    ...command,
  ]);
}

// A string tmux parses as one word of a command (tmux(1), PARSING SYNTAX):
// double-quoted, with the three characters it escapes there escaped.
export function tmuxQuoted(text: string): string {
  return `"${text.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}

// Commands as the text of one command list, for a command that takes one —
// if-shell's, which tmux parses as it is (measured: not format-expanded).
function commandText(commands: readonly Command[]): string {
  return commands.map((c) => c.map(tmuxQuoted).join(" ")).join(" ; ");
}

// Reads run in one invocation, each answer told from the next by a line no
// option holds (measured: `display-message -p` prints it as it is).
const SEPARATOR = "ccb:separator";
function readChain(queries: readonly Command[]): string[] {
  return chain(
    queries.flatMap((q, i) =>
      i === 0 ? [q] : [["display-message", "-p", SEPARATOR], q],
    ),
  );
}
// Each answer's text, a value's trailing newline dropped: "" where the option
// is unset (`-q`).
function answersOf(stdout: string, count: number): string[] | null {
  const parts = stdout.split(`${SEPARATOR}\n`);
  return parts.length === count ? parts.map((p) => p.replace(/\n$/, "")) : null;
}

const show = (session: string, option: string): Command => [
  "show-options",
  "-q",
  "-v",
  "-t",
  session,
  option,
];
const showGlobal = (option: string): Command => [
  "show-options",
  "-g",
  "-q",
  "-v",
  option,
];

// What tmux says of a session's own `status` and `status-format`: the
// answers to OWN_QUERIES.
interface Own {
  readonly status: string | null;
  readonly formats: Formats | null;
}
const ownQueries = (session: string): Command[] => [
  ["show-options", "-t", session],
  show(session, "status"),
  ...INDICES.map((i) => show(session, formatOption(i))),
];
function ownOf(answers: readonly string[]): Own {
  const [listing = "", status = "", ...formats] = answers;
  const names = listing.split("\n").map((line) => line.split(" ")[0] ?? "");
  const own: Record<number, string> = {};
  for (const i of INDICES)
    if (names.includes(formatOption(i))) own[i] = formats[i] ?? "";
  const hasArray =
    names.includes("status-format") || Object.keys(own).length > 0;
  return {
    status: names.includes("status") ? status : null,
    formats: hasArray ? own : null,
  };
}

// The session's whole `status-format` set to `formats` — unset, so the
// session reads the global array again, for null.
function arrayWrite(session: string, formats: Formats | null): Command[] {
  return [
    ["set-option", "-u", "-t", session, "status-format"],
    ...Object.entries(formats ?? {}).map(([i, value]) => [
      "set-option",
      "-t",
      session,
      formatOption(Number(i)),
      tmuxArg(value),
    ]),
  ];
}

// ─── The plans: what to ask tmux, and what to write from its answers ───────
//
// [LAW:effects-at-boundaries] Pure: the owner runs them asynchronously while
// the daemon runs and synchronously at its shutdown.

// Laying a session out: its `status`, its own array, the global array (the
// rows below the bar's come from whichever the session reads), and what a
// daemon before this one left there.
const INSTALL_QUERIES = (session: string): Command[] => [
  ["display-message", "-p", "-t", session, "#{status}"],
  ...ownQueries(session),
  ...INDICES.map((i) => showGlobal(formatOption(i))),
  show(session, PRIOR_OPTION),
  show(session, WROTE_OPTION),
];

// [LAW:parse-dont-validate] What a daemon left in a session's options (its
// `@cc-candybar-status-prior` and `-wrote`, non-empty): this daemon's layout,
// with the height it last wrote, or a reason to leave the session alone — a
// record that does not read, or one another daemon wrote.
export type LeftBehind =
  | { readonly kind: "ours"; readonly prior: Prior; readonly status: number }
  | { readonly kind: "theirs"; readonly why: string };

export function leftBehind(
  prior: string,
  wrote: string,
  owner: string,
): LeftBehind {
  let parsed: Prior;
  let status: number;
  try {
    parsed = JSON.parse(prior) as Prior;
    status = wrote === "" ? parsed.base : statusRows(wrote);
  } catch (error) {
    return {
      kind: "theirs",
      why: `${PRIOR_OPTION} does not read (${String(error)})`,
    };
  }
  return parsed.owner === owner
    ? { kind: "ours", prior: parsed, status }
    : {
        kind: "theirs",
        why: `the daemon at ${JSON.stringify(parsed.owner)} draws it`,
      };
}

export type Install =
  | LeftBehind
  | {
      readonly kind: "lay-out";
      readonly prior: Prior;
      readonly commands: readonly Command[];
    };

export function installPlan(
  session: string,
  answers: readonly string[],
  owner: string,
): Install {
  const [statusWordNow = "", ...rest] = answers;
  const own = ownOf(rest.slice(0, 2 + MAX_STATUS_ROWS));
  const globals = rest.slice(2 + MAX_STATUS_ROWS, 2 + 2 * MAX_STATUS_ROWS);
  const [prior = "", wrote = ""] = rest.slice(2 + 2 * MAX_STATUS_ROWS);
  if (prior !== "") return leftBehind(prior, wrote, owner);
  const base = statusRows(statusWordNow);
  const above: Record<number, string> = {};
  for (let i = 0; i < base; i++) {
    const value = own.formats === null ? globals[i] : own.formats[i];
    if (value !== undefined && value !== "") above[i] = value;
  }
  const wroteFormats: Formats = {
    ...above,
    ...Object.fromEntries(
      Array.from({ length: MAX_STATUS_ROWS - base }, (_, i) => [
        base + i,
        rowFormat(i),
      ]),
    ),
  };
  const laid: Prior = {
    owner,
    base,
    status: own.status,
    formats: own.formats,
    wrote: wroteFormats,
  };
  return {
    kind: "lay-out",
    prior: laid,
    commands: [
      ["set-option", "-t", session, PRIOR_OPTION, JSON.stringify(laid)],
      ...arrayWrite(session, wroteFormats),
    ],
  };
}

// Putting a session back: what it holds now, against what the daemon wrote.
const RESTORE_QUERIES = (session: string): Command[] => [
  ...ownQueries(session),
  show(session, WROTE_OPTION),
];

// [LAW:one-source-of-truth] Compare-and-restore: what the daemon wrote goes
// back to what was there before only where tmux still holds the daemon's
// value; one set since — a re-sourced tmux.conf — is the user's.
export function restorePlan(
  session: string,
  prior: Prior,
  answers: readonly string[],
): { readonly commands: readonly Command[]; readonly kept: readonly string[] } {
  const own = ownOf(answers.slice(0, 2 + MAX_STATUS_ROWS));
  const wrote = answers[2 + MAX_STATUS_ROWS] ?? "";
  const commands: Command[] = [];
  const kept: string[] = [];
  if (sameFormats(own.formats, prior.wrote))
    commands.push(...arrayWrite(session, prior.formats));
  else {
    // The user wrote the array since: theirs stays, less the rows that still
    // draw the daemon's options.
    kept.push("status-format");
    for (const [i, value] of Object.entries(own.formats ?? {}))
      if (Number(i) >= prior.base && value === prior.wrote[Number(i)])
        commands.push(["set-option", "-u", "-t", session, formatOption(+i)]);
  }
  if (wrote !== "") {
    if (own.status === wrote)
      commands.push(
        prior.status === null
          ? ["set-option", "-u", "-t", session, "status"]
          : ["set-option", "-t", session, "status", tmuxArg(prior.status)],
      );
    else kept.push("status");
  }
  commands.push(
    ...INDICES.map((i) => [
      "set-option",
      "-q",
      "-u",
      "-t",
      session,
      rowOption(i),
    ]),
    ["set-option", "-q", "-u", "-t", session, PRIOR_OPTION],
    ["set-option", "-q", "-u", "-t", session, WROTE_OPTION],
  );
  return { commands, kept };
}

// The command a root `MouseDown1Status` binding runs, as `list-keys` prints
// the line binding it: a note and a repeat flag may sit before the table, and
// a whole table's listing pads the key's column with spaces.
const BOUND =
  /^bind-key\s+(?:-r\s+)?(?:-N\s+(?:"(?:[^"\\]|\\.)*"|\S+)\s+)?-T\s+root\s+MouseDown1Status\s+(.+)$/m;
// The root table (never empty, so `list-keys` of it answers).
const ROOT_KEYS: Command[] = [["list-keys", "-T", "root"]];

// The line binding MouseDown1Status in the root table, and what it runs.
export interface Bound {
  readonly line: string;
  readonly command: string;
}
export function boundOf(listKeys: string): Bound | null {
  const found = BOUND.exec(listKeys);
  return found === null ? null : { line: found[0], command: found[1]! };
}

// [LAW:one-source-of-truth] The link a status-line click runs, as this module
// writes it into the binding and reads it back in `linkAt`: tmux expands the
// pane (its `%` stripped, which a URL would read as an escape) and the range,
// shell-quoted, before the shell runs the line.
const CLICK_URL = `cc-candybar://${VERB_TMUX_STATUS_CLICK}/`;
const clickUrl = (socket: string): string =>
  `${CLICK_URL}${encodeSegments([socket])}/#{s/%//:pane_id}/#{q:mouse_status_range}`;

// A binding a cc-candybar daemon wrote — this one or any other — told by the
// click it runs, which `list-keys` prints as it was bound whatever the
// padding before it.
const isClickBinding = (bound: Bound | null): boolean =>
  bound?.command.includes(CLICK_URL) ?? false;

// What `@cc-candybar-binding-prior` holds: the daemon that bound the click,
// and the binding it replaced.
interface BindingRecord {
  readonly owner: string;
  readonly prior: Bound | null;
}

// [LAW:one-source-of-truth] Compare-and-restore, as for a layout: the binding
// goes back to `prior` only while it is still a cc-candybar one.
function bindingRestorePlan(
  prior: Bound | null,
  listKeys: string,
): {
  readonly steps: ReadonlyArray<{ command: Command; stdin?: string }>;
  readonly said: string;
} {
  const forget = {
    command: ["set-option", "-g", "-q", "-u", BINDING_OPTION],
  };
  if (!isClickBinding(boundOf(listKeys)))
    return {
      steps: [forget],
      said: "left MouseDown1Status as it is: bound again since",
    };
  return {
    steps: [
      prior === null
        ? { command: ["unbind-key", ...CLICK_KEY] }
        : { command: ["source-file", "-"], stdin: `${prior.line}\n` },
      forget,
    ],
    said: `restored MouseDown1Status to ${prior === null ? "unbound" : JSON.stringify(prior.line)}`,
  };
}

export interface TmuxStatusEdge {
  // One tmux invocation against the server at `socket`.
  run(
    socket: string,
    args: readonly string[],
    stdin?: string,
  ): Promise<TmuxRun>;
}

// One tmux invocation that finishes before it returns: the daemon's shutdown
// cannot wait, so whoever ends the process hands this to `restoreAll`.
export type TmuxAtExit = (
  socket: string,
  args: readonly string[],
  stdin?: string,
) => TmuxRun;

export interface TmuxStatusDeps {
  readonly edge: TmuxStatusEdge;
  readonly subscribe: (sessionId: string, sub: Subscriber) => () => void;
  // The session whose statusline last rendered from `pane`, as the daemon
  // holds it — a /clear or a new Claude Code in the pane takes it over.
  readonly sessionInPane: (socket: string, pane: string) => string | null;
  // The shell words that deliver a `cc-candybar://` URL, the last argument, to
  // this daemon — what a click on one of its ranges runs.
  readonly handler: string;
  // This daemon's socket: what it writes into tmux is marked with it.
  readonly owner: string;
  readonly log: (level: "info" | "warn", msg: string) => void;
}

interface Held {
  readonly sessionId: string;
  readonly socket: string;
  readonly pane: string;
  unsubscribe: (() => void) | null;
  frame: TmuxStatusBar | null;
}

// A tmux session the daemon has laid out: what was there before, and what it
// last wrote (rows and the status line's height).
interface Layout {
  readonly prior: Prior;
  rows: readonly string[];
  status: number;
}

// [LAW:types-are-the-program] The server's click binding as the daemon knows
// it: not its own; one a daemon on this socket left, to bind again as this
// process; its own, with what it replaced; or left alone — another daemon's.
type Binding =
  | { readonly kind: "none" }
  | { readonly kind: "adopted"; readonly prior: Bound | null }
  | { readonly kind: "ours"; readonly prior: Bound | null }
  | { readonly kind: "left"; readonly why: string };

interface Server {
  view: StatusLines | null;
  adopted: boolean;
  readonly layouts: Map<string, Layout>;
  // Sessions laid out by something other than this daemon, and why, left
  // alone until no held pane is in them.
  readonly left: Map<string, string>;
  binding: Binding;
  // [LAW:no-ambient-temporal-coupling] The reconcile running now, if any, and
  // whether something changed while it ran — one more runs after it, never a
  // second beside it.
  running: Promise<void> | null;
  again: boolean;
  // The last failure said, so a failing write is logged when it starts
  // failing, not once a frame.
  lastFailure: string | null;
}

export interface TmuxStatusStats {
  readonly sessions: number;
  readonly layouts: number;
  readonly writes: number;
  readonly failedWrites: number;
}

// What a click on one of the daemon's status-line ranges stands for.
export type StatusClick =
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * [LAW:single-enforcer] The one writer of this lane's tmux state: every
 * session's rows, every status line's layout, every server's click binding.
 * [LAW:no-shared-mutable-globals] One owner, the daemon; its maps are written
 * only through observe / answered / the subscriptions it holds.
 */
export class TmuxStatusLines {
  private readonly held = new Map<string, Held>();
  private readonly servers = new Map<string, Server>();
  private closed = false;
  private writes = 0;
  private failedWrites = 0;

  constructor(private readonly deps: TmuxStatusDeps) {}

  // [LAW:dataflow-not-control-flow] Level-triggered, at events — a request's
  // arrival with its own hints, a click's commit with its session's latest —
  // never at a draw: a session whose switch is on and that reported a tmux
  // pane is held, any other is not. A daemon restart picks each session up at
  // its next request.
  observe(
    sessionId: string,
    tmux: TmuxHint | null | undefined,
    on: boolean,
  ): void {
    if (this.closed) return;
    const held = this.held.get(sessionId);
    const where = on && tmux !== null && tmux !== undefined ? tmux : null;
    if (
      held !== undefined &&
      (where === null ||
        held.socket !== where.socket ||
        held.pane !== where.pane)
    )
      this.release(held, "switched off or moved");
    if (where === null || this.held.has(sessionId)) return;
    const entry: Held = {
      sessionId,
      socket: where.socket,
      pane: where.pane,
      unsubscribe: null,
      frame: null,
    };
    this.held.set(sessionId, entry);
    this.serverOf(where.socket);
    this.deps.log(
      "info",
      `tmux-status: holding sid=${JSON.stringify(sessionId)} pane=${where.pane} socket=${JSON.stringify(where.socket)}`,
    );
    // [LAW:effects-at-boundaries] Subscribed in the caller's turn: a
    // subscribe draws nothing there, since its first frame falls due on the
    // feed's own timer (src/daemon/frame-feed.ts). A feed already open hands
    // over its frame at once, and the reconcile that starts then runs tmux as
    // a request's other refreshes do: started in its turn, awaited in none.
    entry.unsubscribe = this.deps.subscribe(sessionId, {
      lane: "tmuxStatus",
      frame: (bar) => {
        entry.frame = laneEncoded(tmuxStatusFrame, bar);
        this.reconcile(entry.socket);
      },
      refused: (resp) => {
        if (this.held.get(sessionId) === entry)
          this.release(entry, `refused: ${resp.error}`);
      },
      drawing: () => this.draws(entry),
    });
  }

  // Every answer PaneVisibility gets from a server: what its status lines
  // show. A held pane gone from it, or taken over by another session, is
  // released.
  answered(socket: string, view: StatusLines): void {
    if (this.closed) return;
    const server = this.serverOf(socket);
    server.view = view;
    for (const held of [...this.held.values()]) {
      if (held.socket !== socket) continue;
      if (!view.sessionOf.has(held.pane)) this.release(held, "pane gone");
      else {
        const newest = this.deps.sessionInPane(socket, held.pane);
        if (newest !== null && newest !== held.sessionId)
          this.release(held, `pane taken by sid=${JSON.stringify(newest)}`);
      }
    }
    this.reconcile(socket);
  }

  // Whether `held`'s bar is in a status line now: a session this daemon laid
  // out, whose status line shows `held`'s pane. Another held pane in the same
  // tmux session draws nowhere but its own statusline.
  private draws(held: Held): boolean {
    const server = this.servers.get(held.socket);
    const session = server?.view?.sessionOf.get(held.pane);
    return (
      session !== undefined &&
      server!.layouts.has(session) &&
      server!.view!.shownBy.get(session) === held.pane
    );
  }

  // [LAW:single-enforcer] The daemon's shutdown: everything put back, now —
  // a few synchronous tmux calls a server, whatever is in flight.
  restoreAll(atExit: TmuxAtExit): void {
    this.closed = true;
    for (const held of this.held.values()) held.unsubscribe?.();
    this.held.clear();
    for (const [socket, server] of this.servers) {
      for (const [session, layout] of [...server.layouts]) {
        server.layouts.delete(session);
        const answers = this.askSync(atExit, socket, RESTORE_QUERIES(session));
        if (answers === null) continue;
        const plan = restorePlan(session, layout.prior, answers);
        this.writeSync(atExit, socket, plan.commands);
        this.saidRestored(socket, session, plan.kept);
      }
      const binding = server.binding;
      server.binding = { kind: "none" };
      if (binding.kind === "ours" || binding.kind === "adopted") {
        const answers = this.askSync(atExit, socket, ROOT_KEYS);
        if (answers === null) continue;
        this.writeBindingRestoreSync(
          atExit,
          socket,
          binding.prior,
          answers[0] ?? "",
        );
      }
    }
  }

  // A click on the range `<range>` of pane `%<n>` on the server `<socket>`
  // (segments, as the binding's URL carries them): the link the frame the
  // daemon drew there marks it with.
  linkAt(value: string): StatusClick {
    const segments = segmentsOf(value);
    const [socket, pane, range, ...extra] = segments ?? [];
    if (
      segments === null ||
      socket === undefined ||
      pane === undefined ||
      range === undefined ||
      extra.length > 0
    )
      return {
        kind: "refused",
        reason: `tmux-status-click needs <socket>/<pane>/<range>, got ${JSON.stringify(value)}`,
      };
    const held = [...this.held.values()].find(
      (h) => h.socket === socket && h.pane === `%${pane}`,
    );
    const url = held?.frame?.links[range];
    return url === undefined
      ? {
          kind: "refused",
          reason: `pane %${pane}'s status line draws no link ${range} now`,
        }
      : { kind: "link", url };
  }

  stats(): TmuxStatusStats {
    return {
      sessions: this.held.size,
      layouts: [...this.servers.values()].reduce(
        (n, s) => n + s.layouts.size,
        0,
      ),
      writes: this.writes,
      failedWrites: this.failedWrites,
    };
  }

  // Resolves once every reconcile asked for so far has run.
  async settled(): Promise<void> {
    for (const server of this.servers.values()) await server.running;
  }

  private serverOf(socket: string): Server {
    const known = this.servers.get(socket);
    if (known !== undefined) return known;
    const server: Server = {
      view: null,
      adopted: false,
      layouts: new Map(),
      left: new Map(),
      binding: { kind: "none" },
      running: null,
      again: false,
      lastFailure: null,
    };
    this.servers.set(socket, server);
    return server;
  }

  private release(held: Held, why: string): void {
    held.unsubscribe?.();
    this.held.delete(held.sessionId);
    this.deps.log(
      "info",
      `tmux-status: released sid=${JSON.stringify(held.sessionId)} pane=${held.pane} — ${why}`,
    );
    this.reconcile(held.socket);
  }

  // [LAW:no-ambient-temporal-coupling] The server's one reconcile loop: a
  // change while one runs asks for one more after it, never a second beside
  // it, so the server's calls run in the order decided and each reconcile
  // reads the newest frame.
  private reconcile(socket: string): void {
    const server = this.servers.get(socket);
    if (server === undefined || this.closed) return;
    if (server.running !== null) {
      server.again = true;
      return;
    }
    server.running = (async () => {
      try {
        do {
          server.again = false;
          await this.step(socket, server);
        } while (server.again && !this.closed);
      } catch (error) {
        this.deps.log(
          "warn",
          `tmux-status: socket=${JSON.stringify(socket)} reconcile threw: ${String(error)}`,
        );
      } finally {
        server.running = null;
      }
    })();
  }

  // [LAW:dataflow-not-control-flow] What the server's status lines should
  // hold, written where it differs from what they hold: per tmux session, the
  // rows of the held pane its status line shows, or none.
  private async step(socket: string, server: Server): Promise<void> {
    const view = server.view;
    if (view === null) return;
    if (!server.adopted) {
      server.adopted = true;
      await this.adopt(socket, server);
    }
    const panesIn = new Map<string, Held[]>();
    for (const held of this.held.values()) {
      if (held.socket !== socket) continue;
      const session = view.sessionOf.get(held.pane);
      if (session === undefined) continue;
      panesIn.set(session, [...(panesIn.get(session) ?? []), held]);
    }
    for (const session of new Set([
      ...server.layouts.keys(),
      ...server.left.keys(),
      ...panesIn.keys(),
    ])) {
      if (this.closed) return;
      const panes = panesIn.get(session) ?? [];
      const known = server.layouts.get(session);
      if (panes.length === 0) {
        server.left.delete(session);
        if (known !== undefined) await this.restore(socket, server, session);
        continue;
      }
      if (server.left.has(session)) continue;
      const layout = known ?? (await this.install(socket, server, session));
      if (layout === null) continue;
      const shown = panes.find((h) => h.pane === view.shownBy.get(session));
      const rows =
        shown?.frame?.rows.slice(0, MAX_STATUS_ROWS - layout.prior.base) ?? [];
      await this.draw(socket, session, layout, rows);
    }
    if (this.closed) return;
    if (server.layouts.size > 0) await this.installBinding(socket, server);
    else await this.restoreBinding(socket, server);
  }

  // The first answer from a server: the layouts and the binding a daemon on
  // this socket left there are taken over, so the reconcile that follows
  // keeps or restores them like its own; what another daemon draws is left.
  private async adopt(socket: string, server: Server): Promise<void> {
    const run = await this.run(socket, [
      "list-sessions",
      "-F",
      `#{session_id}\t#{${PRIOR_OPTION}}\t#{${WROTE_OPTION}}`,
    ]);
    if (run.kind === "ok") {
      for (const line of run.stdout.split("\n")) {
        const [session, prior, wrote = ""] = line.split("\t");
        if (session === undefined || prior === undefined || prior === "")
          continue;
        const found = leftBehind(prior, wrote, this.deps.owner);
        if (found.kind === "ours")
          server.layouts.set(session, {
            prior: found.prior,
            rows: [],
            status: found.status,
          });
        else this.leave(socket, server, session, found.why);
      }
    }
    const answers = await this.ask(socket, [showGlobal(BINDING_OPTION)]);
    const saved = answers?.[0] ?? "";
    if (saved !== "") {
      try {
        const record = JSON.parse(saved) as BindingRecord;
        if (record.owner === this.deps.owner)
          server.binding = { kind: "adopted", prior: record.prior };
      } catch (error) {
        this.deps.log(
          "warn",
          `tmux-status: socket=${JSON.stringify(socket)} ${BINDING_OPTION} does not read (${String(error)}), left as it is`,
        );
      }
    }
    if (server.layouts.size > 0 || server.binding.kind === "adopted")
      this.deps.log(
        "info",
        `tmux-status: socket=${JSON.stringify(socket)} took over layouts=${[...server.layouts.keys()].join(",") || "-"} binding=${server.binding.kind}`,
      );
  }

  // A tmux session this daemon does not draw while what is laid out there is
  // not its own — said once, when it is first met.
  private leave(
    socket: string,
    server: Server,
    session: string,
    why: string,
  ): void {
    server.left.set(session, why);
    this.deps.log(
      "warn",
      `tmux-status: socket=${JSON.stringify(socket)} session ${session} left as it is: ${why}`,
    );
  }

  private async install(
    socket: string,
    server: Server,
    session: string,
  ): Promise<Layout | null> {
    const answers = await this.ask(socket, INSTALL_QUERIES(session));
    // [LAW:no-ambient-temporal-coupling] A shutdown during the ask has
    // restored everything it knew of; a layout begun now would outlive it.
    if (answers === null || this.closed) return null;
    const plan = installPlan(session, answers, this.deps.owner);
    if (plan.kind === "theirs") {
      this.leave(socket, server, session, plan.why);
      return null;
    }
    // Known before it is written, so a shutdown while the write is in flight
    // still puts it back.
    const layout: Layout = {
      prior: plan.prior,
      rows: [],
      status: plan.kind === "ours" ? plan.status : plan.prior.base,
    };
    server.layouts.set(session, layout);
    if (plan.kind === "lay-out") await this.write(socket, plan.commands);
    this.deps.log(
      "info",
      `tmux-status: socket=${JSON.stringify(socket)} ${plan.kind === "ours" ? "took over" : "laid out"} session ${session} base=${plan.prior.base} own=${[plan.prior.status === null ? [] : ["status"], plan.prior.formats === null ? [] : ["status-format"]].flat().join(",") || "-"}`,
    );
    return layout;
  }

  private async draw(
    socket: string,
    session: string,
    layout: Layout,
    rows: readonly string[],
  ): Promise<void> {
    const status = layout.prior.base + rows.length;
    const commands: Command[] = [];
    rows.forEach((row, i) => {
      if (layout.rows[i] !== row)
        commands.push(["set-option", "-t", session, rowOption(i), row]);
    });
    if (status !== layout.status) {
      const word = statusWord(status);
      commands.push(
        ["set-option", "-t", session, "status", word],
        ["set-option", "-t", session, WROTE_OPTION, word],
      );
    }
    // What tmux holds is what a write it took left there: a failed one leaves
    // the layout as it was, so the next reconcile writes it again.
    const took =
      commands.length === 0 ||
      (await this.write(socket, [
        [
          "if-shell",
          "-F",
          "-t",
          session,
          `#{${PRIOR_OPTION}}`,
          commandText(commands),
        ],
      ]));
    if (!took) return;
    layout.rows = rows;
    layout.status = status;
  }

  private async restore(
    socket: string,
    server: Server,
    session: string,
  ): Promise<void> {
    const layout = server.layouts.get(session);
    if (layout === undefined) return;
    server.layouts.delete(session);
    const answers = await this.ask(socket, RESTORE_QUERIES(session));
    if (answers === null) return;
    const plan = restorePlan(session, layout.prior, answers);
    await this.write(socket, plan.commands);
    this.saidRestored(socket, session, plan.kept);
  }

  private saidRestored(
    socket: string,
    session: string,
    kept: readonly string[],
  ): void {
    this.deps.log(
      "info",
      `tmux-status: socket=${JSON.stringify(socket)} restored session ${session} kept=${kept.join(",") || "-"}`,
    );
  }

  // The server's click binding made this process's: bound over whatever the
  // user had (or, for one a daemon on this socket left, over what IT
  // replaced), with the record of what it replaced written in the same tmux
  // call — so tmux never holds the binding without it. Another daemon's
  // binding is left alone.
  private async installBinding(socket: string, server: Server): Promise<void> {
    const binding = server.binding;
    if (binding.kind === "ours" || binding.kind === "left") return;
    const answers = await this.ask(socket, ROOT_KEYS);
    // [LAW:no-ambient-temporal-coupling] As for a layout: nothing is bound
    // after the shutdown's restore.
    if (answers === null || this.closed) return;
    const bound = boundOf(answers[0] ?? "");
    if (binding.kind === "none" && isClickBinding(bound)) {
      server.binding = {
        kind: "left",
        why: "another cc-candybar daemon's status-line clicks are bound to MouseDown1Status; left as it is, so this daemon's are off",
      };
      this.deps.log(
        "warn",
        `tmux-status: socket=${JSON.stringify(socket)} ${server.binding.why}`,
      );
      return;
    }
    // An adopted record holds while its binding is still bound; one the user
    // replaced since is theirs, and what this bind replaces.
    const prior =
      binding.kind === "adopted" && isClickBinding(bound)
        ? binding.prior
        : bound;
    const record: BindingRecord = { owner: this.deps.owner, prior };
    // Known before it is written, so a shutdown while the write is in flight
    // still puts it back.
    server.binding = { kind: "ours", prior };
    const took = await this.write(socket, [
      [
        "bind-key",
        ...CLICK_KEY,
        "if-shell",
        "-F",
        `#{m:${RANGE_PREFIX}*,#{mouse_status_range}}`,
        `run-shell -b ${tmuxQuoted(`${this.deps.handler} ${clickUrl(socket)}`)}`,
        ...(prior === null ? [] : [prior.command]),
      ],
      ["set-option", "-g", BINDING_OPTION, JSON.stringify(record)],
    ]);
    // A bind tmux refused leaves nothing to put back; the next reconcile
    // binds again.
    if (!took) {
      server.binding = binding;
      return;
    }
    this.deps.log(
      "info",
      `tmux-status: socket=${JSON.stringify(socket)} bound MouseDown1Status (was ${prior === null ? "unbound" : JSON.stringify(prior.line)})`,
    );
  }

  private async restoreBinding(socket: string, server: Server): Promise<void> {
    const binding = server.binding;
    server.binding = { kind: "none" };
    if (binding.kind !== "ours" && binding.kind !== "adopted") return;
    const answers = await this.ask(socket, ROOT_KEYS);
    if (answers === null) return;
    const plan = bindingRestorePlan(binding.prior, answers[0] ?? "");
    for (const step of plan.steps)
      await this.write(socket, [step.command], step.stdin);
    this.deps.log(
      "info",
      `tmux-status: socket=${JSON.stringify(socket)} ${plan.said}`,
    );
  }

  private writeBindingRestoreSync(
    atExit: TmuxAtExit,
    socket: string,
    prior: Bound | null,
    listKeys: string,
  ): void {
    const plan = bindingRestorePlan(prior, listKeys);
    for (const step of plan.steps)
      this.writeSync(atExit, socket, [step.command], step.stdin);
    this.deps.log(
      "info",
      `tmux-status: socket=${JSON.stringify(socket)} ${plan.said}`,
    );
  }

  // ─── tmux, counted ───────────────────────────────────────────────────────

  // A failure is counted, and logged when it differs from the server's last.
  private counted(socket: string, run: TmuxRun): TmuxRun {
    const server = this.serverOf(socket);
    if (run.kind === "ok") {
      server.lastFailure = null;
      return run;
    }
    this.failedWrites++;
    if (server.lastFailure !== run.reason)
      this.deps.log(
        "warn",
        `tmux-status: socket=${JSON.stringify(socket)} ${run.reason}`,
      );
    server.lastFailure = run.reason;
    return run;
  }

  private async run(socket: string, args: readonly string[], stdin?: string) {
    return this.counted(socket, await this.deps.edge.run(socket, args, stdin));
  }

  private async ask(
    socket: string,
    queries: readonly Command[],
  ): Promise<string[] | null> {
    const run = await this.run(socket, readChain(queries));
    return run.kind === "ok" ? answersOf(run.stdout, queries.length) : null;
  }

  private askSync(
    atExit: TmuxAtExit,
    socket: string,
    queries: readonly Command[],
  ): string[] | null {
    const run = this.counted(socket, atExit(socket, readChain(queries)));
    return run.kind === "ok" ? answersOf(run.stdout, queries.length) : null;
  }

  // Whether tmux took the write.
  private async write(
    socket: string,
    commands: readonly Command[],
    stdin?: string,
  ): Promise<boolean> {
    if (commands.length === 0) return true;
    this.writes++;
    return (await this.run(socket, chain(commands), stdin)).kind === "ok";
  }

  private writeSync(
    atExit: TmuxAtExit,
    socket: string,
    commands: readonly Command[],
    stdin?: string,
  ): void {
    if (commands.length === 0) return;
    this.writes++;
    this.counted(socket, atExit(socket, chain(commands), stdin));
  }
}

// A status-line click's segments, or null when one is not percent-encoded:
// a value it cannot read is refused like any other it cannot use.
function segmentsOf(value: string): string[] | null {
  try {
    return decodeSegments(value);
  } catch (err) {
    if (err instanceof URIError) return null;
    throw err;
  }
}
