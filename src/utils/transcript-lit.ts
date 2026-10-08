// The lit ticket a session is working, read from the session's own transcript
// (brandon-lit-widget-3xo.btb). lit cannot answer "which ticket is mine" — its
// assignee is whichever Claude session ran `lit start`, which a /clear replaces,
// and calling it per render is too slow — so the one record of the claim is the
// agent's own lit calls and what lit printed back.
//
// [LAW:one-source-of-truth] Like the rest of the activity projection, this runs
// at the one parse site and retains bounded scalars only: ticket ids, status
// and phase words, and the epic counts lit prints in its sentinel line. No
// command text and no tool output survives the projection.

// The epic progress lit reports beside a ticket. `null` epic in the sentinel
// means the ticket has no parent — a real answer, distinct from no sentinel.
export interface LitEpic {
  readonly id: string;
  readonly done: number;
  readonly total: number;
}

// One `lit:state {…}` line from a lit command's output (links-next-output-2ug2):
// the ticket the command acted on, its status, and its epic's progress. A line
// that claims the prefix but does not parse is `unreadable` — carried to the
// bar, never dropped, since it means lit's format and this reader disagree.
export type LitSentinel =
  | {
      readonly kind: "state";
      readonly id: string;
      readonly status: string;
      readonly epic: LitEpic | null;
    }
  | { readonly kind: "unreadable"; readonly line: string };

// A lit call that moves a ticket to a status: `lit start <id>` → in_progress,
// `lit done|close <id>` → closed. It is a CLAIM until lit's own words in that
// call's result say the ticket is there — the shell's exit status cannot say
// it (`lit start x | tail -3` exits with tail's, `lit start x && git …` with
// git's).
export interface LitClaim {
  readonly call: string;
  readonly id: string;
  readonly to: LitStatus;
}

export type LitStatus = "in_progress" | "closed";

// What lit said about one ticket in one tool result.
export interface LitSaid {
  readonly call: string;
  readonly id: string;
  readonly status: string;
}

// [LAW:types-are-the-program] Independently optional, like `EntryActivity`: one
// entry can make a claim, name a phase, and carry lit's answers at once.
export interface EntryLit {
  readonly claims?: readonly LitClaim[];
  readonly said?: readonly LitSaid[];
  readonly phase?: string;
  readonly sentinels?: readonly LitSentinel[];
}

// What one tool call is, for phase matching: the tool's name and the one
// string that says what it did — the command for Bash (quoted text and heredoc
// bodies blanked), the skill name for Skill, the tool name itself otherwise.
export interface ToolSubject {
  readonly tool: string;
  readonly subject: string;
}

// [LAW:dataflow-not-control-flow] The workflow vocabulary is DATA: an ordered
// rule list, first match per tool call wins, and the newest matching call since
// the ticket started names the phase. A phase is what the agent set out to do,
// so it moves on the call, not on its result.
export interface PhaseRule {
  readonly phase: string;
  readonly tool: string;
  readonly match: RegExp;
}

// A shell word boundary before `lit`/`gh`: start of command or after a shell
// separator, so `split` or `ghost` never match.
const SH = String.raw`(?:^|[\s;&|(])`;

// A skill named bare or under a plugin namespace (`memento:message-in-a-bottle`).
const skill = (names: string): RegExp => new RegExp(`(?:^|:)(?:${names})$`);

export const WORK_PHASES: readonly PhaseRule[] = [
  { phase: "impl", tool: "Edit", match: /^/ },
  { phase: "impl", tool: "MultiEdit", match: /^/ },
  { phase: "impl", tool: "Write", match: /^/ },
  { phase: "impl", tool: "NotebookEdit", match: /^/ },
  {
    phase: "review",
    tool: "Bash",
    match: new RegExp(`${SH}gh\\s+pr\\s+create\\b`),
  },
  { phase: "review", tool: "Skill", match: skill("code-review|simplify") },
  {
    phase: "groom",
    tool: "Bash",
    match: new RegExp(`${SH}lit\\s+(done|close)\\b`),
  },
  { phase: "groom", tool: "Skill", match: skill("groom-backlog") },
  { phase: "handoff", tool: "Skill", match: skill("message-in-a-bottle") },
];

// `lit <verb> [flags] <id>`: flags (`--take`, `--reason ''` once quotes are
// blanked) may sit between the verb and the id.
const litVerb = (verbs: string): RegExp =>
  new RegExp(
    `${SH}lit\\s+(?:${verbs})(?:\\s+(?:--?[\\w-]+(?:=\\S*)?|''))*\\s+([A-Za-z0-9][\\w.-]*)`,
  );
const CLAIMS: ReadonlyArray<{ readonly verb: RegExp; readonly to: LitStatus }> =
  [
    { verb: litVerb("start"), to: "in_progress" },
    { verb: litVerb("done|close"), to: "closed" },
  ];

// A started ticket enters at `prep` (see `stepTicket`), so no rule names it.
export function phaseOf(call: ToolSubject): string | undefined {
  return WORK_PHASES.find(
    (r) => r.tool === call.tool && r.match.test(call.subject),
  )?.phase;
}

// The claim one tool call makes, if it is a lit start/done/close.
export function litClaim(
  callId: string,
  call: ToolSubject,
): LitClaim | undefined {
  if (call.tool !== "Bash") return undefined;
  for (const { verb, to } of CLAIMS) {
    const id = verb.exec(call.subject)?.[1];
    if (id !== undefined) return { call: callId, id, to };
  }
  return undefined;
}

const SENTINEL_PREFIX = "lit:state ";
const SENTINEL = /^lit:state (.*)$/gm;

// [LAW:parse-dont-validate] The sentinel crossing: a line claiming the prefix
// either parses into a state or is `unreadable` — once, here.
export function litSentinels(text: string): readonly LitSentinel[] {
  return [...text.matchAll(SENTINEL)].map(
    ([line, json]) =>
      parseSentinel(json!) ?? { kind: "unreadable", line: line.trim() },
  );
}

function parseSentinel(json: string): LitSentinel | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { id, status, epic } = raw as Record<string, unknown>;
  if (typeof id !== "string" || typeof status !== "string") return undefined;
  if (epic === null) return { kind: "state", id, status, epic: null };
  if (typeof epic !== "object" || epic === undefined) return undefined;
  const e = epic as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    typeof e.done !== "number" ||
    typeof e.total !== "number"
  ) {
    return undefined;
  }
  return {
    kind: "state",
    id,
    status,
    epic: { id: e.id, done: e.done, total: e.total },
  };
}

// The subject of one tool_use block — see `ToolSubject`.
export function toolSubject(name: string, input: unknown): ToolSubject {
  const i = (input ?? {}) as Record<string, unknown>;
  const subject =
    name === "Bash" && typeof i.command === "string"
      ? shellCode(i.command)
      : name === "Skill" && typeof i.skill === "string"
        ? i.skill
        : name;
  return { tool: name, subject };
}

// A heredoc body and a quoted string are DATA to the shell — a commit message
// saying "after a lit start" runs no lit — so they are blanked before any rule
// reads the command. Approximate shell lexing, erring toward blanking.
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)[\s\S]*?\n\s*\3(?=\n|$)/g;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;

export function shellCode(command: string): string {
  return command.replace(HEREDOC, "$1").replace(QUOTED, "''");
}

// A tool_result's text blocks, whichever shape it arrived in.
function resultTexts(content: unknown): readonly string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) =>
    typeof b === "object" && b !== null && typeof b.text === "string"
      ? [b.text as string]
      : [],
  );
}

// lit's own words about where a ticket is: the `<id> [<status>/…` line it
// prints for a ticket it acted on or shows, and the `Ticket <id> has been
// closed.` line `lit done` prints.
const STATUS_MARK = " [";
const STATUS_LINE = /^(\S+) \[(open|in_progress|closed)\//gm;
const DONE_MARK = "has been closed.";
const DONE_LINE = /^Ticket (\S+) has been closed\./gm;

export interface ResultLit {
  readonly sentinels: readonly LitSentinel[];
  readonly said: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
  }>;
}

const NOTHING: ResultLit = { sentinels: [], said: [] };

// What lit said in one tool_result. Nearly no result carries it, so a block
// without a marker is never regex-scanned — this runs over every result of
// every transcript the daemon parses.
export function resultLit(content: unknown): ResultLit {
  let found:
    | { sentinels: LitSentinel[]; said: Array<ResultLit["said"][number]> }
    | undefined;
  for (const text of resultTexts(content)) {
    const sentinel = text.includes(SENTINEL_PREFIX);
    const status = text.includes(STATUS_MARK);
    const done = text.includes(DONE_MARK);
    if (!sentinel && !status && !done) continue;
    found ??= { sentinels: [], said: [] };
    if (sentinel) found.sentinels.push(...litSentinels(text));
    if (status) {
      for (const [, id, s] of text.matchAll(STATUS_LINE)) {
        found.said.push({ id: id!, status: s! });
      }
    }
    if (done) {
      for (const [, id] of text.matchAll(DONE_LINE)) {
        found.said.push({ id: id!, status: "closed" });
      }
    }
  }
  if (found === undefined) return NOTHING;
  for (const s of found.sentinels) {
    if (s.kind === "state") found.said.push({ id: s.id, status: s.status });
  }
  return found;
}
