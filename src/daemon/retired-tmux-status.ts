// Upgrade cleanup for the old tmux status renderer. Existing ownership
// records live in tmux, so an upgraded daemon can undo its old writes even
// when the previous process did not get to shut down.
import type { TmuxRun } from "../proc/tmux";
import type { Timekeeper } from "../time";
import type { DaemonLogger } from "../utils/logger";
import { ObservableLru } from "../utils/observable-lru";
import { SingleFlight } from "../utils/single-flight";

export const PRIOR_OPTION = "@cc-candybar-status-prior";
export const WROTE_OPTION = "@cc-candybar-status-wrote";
export const BINDING_OPTION = "@cc-candybar-binding-prior";
const MAX_STATUS_ROWS = 5;
const CLICK_KEY = ["-T", "root", "MouseDown1Status"] as const;
const INDICES = Array.from({ length: MAX_STATUS_ROWS }, (_, i) => i);

export const rowOption = (row: number): string => `@cc-candybar-row-${row}`;
const formatOption = (index: number): string => `status-format[${index}]`;

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
function tmuxArg(value: string): string {
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
// answers to the layout queries.
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
  const own = ownOf(answers.slice(0, -1));
  const wrote = answers.at(-1) ?? "";
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
function boundOf(listKeys: string): Bound | null {
  const found = BOUND.exec(listKeys);
  return found === null ? null : { line: found[0], command: found[1]! };
}

// Old Candybar wrapped the original command with this branch and expanded
// this URL from the pressed row. A new binding with that URL in an unrelated
// command is the user's.
const RETIRED_CLICK =
  /^if-shell -F ["']?#{m:ccb\*,#{mouse_status_range}}["']?\s+/;
const RETIRED_TARGET = "cc-candybar://tmux-status-click/";
const RETIRED_SUFFIX = "/#{s/%//:pane_id}/#{q:mouse_status_range}";

function isRetiredBinding(bound: Bound | null, socket: string): boolean {
  return (
    bound !== null &&
    RETIRED_CLICK.test(bound.command) &&
    bound.command.includes(
      `${RETIRED_TARGET}${encodeURIComponent(socket)}${RETIRED_SUFFIX}`,
    )
  );
}

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
  socket: string,
): {
  readonly steps: ReadonlyArray<{ command: Command; stdin?: string }>;
  readonly said: string;
} {
  const forget = {
    command: ["set-option", "-g", "-q", "-u", BINDING_OPTION],
  };
  if (!isRetiredBinding(boundOf(listKeys), socket))
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

// Previous releases emitted an array option as a sparse object indexed by
// tmux's status rows. Reject a corrupt record before a restore can write it.
function validFormats(value: unknown): value is Formats {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([index, text]) => /^[0-4]$/.test(index) && typeof text === "string",
    )
  );
}

function priorLayout(raw: string): Prior {
  const parsed = JSON.parse(raw) as Prior;
  if (
    typeof parsed.owner !== "string" ||
    !INDICES.concat(MAX_STATUS_ROWS).includes(parsed.base) ||
    (parsed.status !== null &&
      (typeof parsed.status !== "string" ||
        !/^(off|on|[2-5])$/.test(parsed.status))) ||
    (parsed.formats !== null && !validFormats(parsed.formats)) ||
    !validFormats(parsed.wrote)
  )
    throw new Error("the previous layout record has an invalid shape");
  return parsed;
}

type Run = (
  socket: string,
  args: readonly string[],
  stdin?: string,
) => Promise<TmuxRun>;

const RETRY_MS = 60_000;

// [LAW:effects-at-boundaries] Restoration is off the render's critical path.
// The checked request supplies the tmux server address; the recorded daemon
// address must match this listener before any command can change that server.
export class RetiredTmuxStatus {
  private readonly flights = new SingleFlight();
  private readonly surveys = new ObservableLru<string, number>(256);

  constructor(
    private readonly owner: string,
    private readonly run: Run,
    private readonly clock: Pick<Timekeeper, "monotonic">,
    private readonly log: DaemonLogger,
  ) {}

  observe(socket: string): Promise<void> {
    this.surveys.touch(socket);
    const next = this.surveys.get(socket);
    if (next !== undefined && this.clock.monotonic() < next)
      return Promise.resolve();
    return this.flights.run(socket, async () => {
      try {
        await this.restore(socket);
        this.surveys.set(socket, Infinity);
      } catch (error) {
        this.surveys.set(socket, this.clock.monotonic() + RETRY_MS);
        this.log(
          "warn",
          `tmux status migration socket=${JSON.stringify(socket)}: ${String(error)}`,
        );
      }
    });
  }

  private async command(
    socket: string,
    args: readonly string[],
    stdin?: string,
  ): Promise<string> {
    const result = await this.run(socket, args, stdin);
    if (result.kind !== "ok") throw new Error(result.reason);
    return result.stdout;
  }

  private async ask(
    socket: string,
    queries: readonly Command[],
  ): Promise<string[]> {
    const stdout = await this.command(socket, readChain(queries));
    const answers = answersOf(stdout, queries.length);
    if (answers === null)
      throw new Error("tmux option response did not match its queries");
    return answers;
  }

  private async restore(socket: string): Promise<void> {
    const sessions = await this.command(socket, [
      "list-sessions",
      "-F",
      `#{session_id}\t#{${PRIOR_OPTION}}`,
    ]);
    for (const line of sessions.split("\n")) {
      const [session, saved] = line.split("\t");
      if (!session || !saved) continue;
      let prior: Prior;
      try {
        prior = priorLayout(saved);
      } catch (error) {
        this.log(
          "warn",
          `tmux status migration socket=${JSON.stringify(socket)} session=${session}: ${String(error)}`,
        );
        continue;
      }
      if (prior.owner !== this.owner) continue;
      const plan = restorePlan(
        session,
        prior,
        await this.ask(socket, RESTORE_QUERIES(session)),
      );
      await this.command(socket, chain(plan.commands));
      this.log(
        "info",
        `tmux status migration socket=${JSON.stringify(socket)} restored session=${session} kept=${plan.kept.join(",") || "-"}`,
      );
    }

    const [saved] = await this.ask(socket, [showGlobal(BINDING_OPTION)]);
    if (!saved) return;
    let record: BindingRecord;
    try {
      record = JSON.parse(saved) as BindingRecord;
      if (
        typeof record.owner !== "string" ||
        (record.prior !== null &&
          (typeof record.prior.line !== "string" ||
            boundOf(record.prior.line)?.line !== record.prior.line))
      )
        throw new Error("the previous binding record has an invalid shape");
    } catch (error) {
      this.log(
        "warn",
        `tmux status migration socket=${JSON.stringify(socket)}: ${String(error)}`,
      );
      return;
    }
    if (record.owner !== this.owner) return;
    const [keys = ""] = await this.ask(socket, ROOT_KEYS);
    const plan = bindingRestorePlan(record.prior, keys, socket);
    for (const step of plan.steps)
      await this.command(socket, step.command, step.stdin);
    this.log(
      "info",
      `tmux status migration socket=${JSON.stringify(socket)} ${plan.said}`,
    );
  }
}
