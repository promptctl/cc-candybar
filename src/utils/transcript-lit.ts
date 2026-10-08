// The lit ticket a session is working, read from the session's own transcript
// (brandon-lit-widget-3xo.btb). lit cannot answer "which ticket is mine" — it
// has no notion of who "you" are, and calling it per render is too slow — so
// the one record of the claim is the agent's own `lit start <id>` call.
//
// [LAW:one-source-of-truth] Like the rest of the activity projection, this runs
// at the one parse site and retains bounded scalars only: a ticket id, a phase
// word, and the epic counts lit prints in its sentinel line. No command text and
// no tool output survives the projection.

// The epic progress lit reports beside a ticket. `null` epic in the sentinel
// means the ticket has no parent — a real answer, distinct from no sentinel.
export interface LitEpic {
  readonly id: string;
  readonly done: number;
  readonly total: number;
}

// One `lit:state {…}` line from a lit command's output (links-next-output-2ug2):
// the ticket the command acted on and its epic's progress.
export interface LitSentinel {
  readonly id: string;
  readonly epic: LitEpic | null;
}

// [LAW:types-are-the-program] Independently optional, like `EntryActivity`: one
// entry can start a ticket and name a phase at once (`lit start` is both).
export interface EntryLit {
  // A `lit start` call: the id it claims and the tool call whose result decides
  // whether the claim held — lit refuses a bogus or already-claimed id.
  readonly started?: { readonly call: string; readonly id: string };
  // Tool calls whose result came back `is_error`.
  readonly refused?: readonly string[];
  readonly phase?: string;
  readonly sentinels?: readonly LitSentinel[];
}

// What one tool call is, for phase matching: the tool's name and the one
// string that says what it did — the command for Bash, the skill name for
// Skill, the tool name itself otherwise.
export interface ToolSubject {
  readonly tool: string;
  readonly subject: string;
}

// [LAW:dataflow-not-control-flow] The workflow vocabulary is DATA: an ordered
// rule list, first match per tool call wins, and the newest matching call since
// the ticket started names the phase.
export interface PhaseRule {
  readonly phase: string;
  readonly tool: string;
  readonly match: RegExp;
}

// A shell word boundary before `lit`/`gh`: start of command or after a shell
// separator, so `split` or `ghost` never match.
const SH = String.raw`(?:^|[\s;&|(])`;

export const WORK_PHASES: readonly PhaseRule[] = [
  { phase: "impl", tool: "Edit", match: /^/ },
  { phase: "impl", tool: "Write", match: /^/ },
  { phase: "impl", tool: "NotebookEdit", match: /^/ },
  {
    phase: "review",
    tool: "Bash",
    match: new RegExp(`${SH}gh\\s+pr\\s+create\\b`),
  },
  { phase: "review", tool: "Skill", match: /^(code-review|simplify)$/ },
  {
    phase: "groom",
    tool: "Bash",
    match: new RegExp(`${SH}lit\\s+(done|close)\\b`),
  },
  { phase: "groom", tool: "Skill", match: /groom-backlog$/ },
  { phase: "handoff", tool: "Skill", match: /message-in-a-bottle$/ },
];

const LIT_START = new RegExp(`${SH}lit\\s+start\\s+([A-Za-z0-9][\\w.-]*)`);

// A started ticket enters at `prep` (see `stepTicket`), so no rule names it.
export function phaseOf(call: ToolSubject): string | undefined {
  return WORK_PHASES.find(
    (r) => r.tool === call.tool && r.match.test(call.subject),
  )?.phase;
}

export function startedTicket(call: ToolSubject): string | undefined {
  return call.tool === "Bash" ? LIT_START.exec(call.subject)?.[1] : undefined;
}

const SENTINEL_PREFIX = "lit:state ";
const SENTINEL = /^lit:state (\{.*\})$/gm;

// [LAW:parse-dont-validate] The sentinel crossing: a line either parses into a
// `LitSentinel` or is not one. lit owns the format; a line that claims the
// prefix but does not parse is refused here, once, and never reaches the fold.
export function litSentinels(text: string): readonly LitSentinel[] {
  const found: LitSentinel[] = [];
  for (const [, json] of text.matchAll(SENTINEL)) {
    const parsed = parseSentinel(json!);
    if (parsed !== undefined) found.push(parsed);
  }
  return found;
}

function parseSentinel(json: string): LitSentinel | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { id, epic } = raw as Record<string, unknown>;
  if (typeof id !== "string") return undefined;
  if (epic === null || epic === undefined) return { id, epic: null };
  const e = epic as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    typeof e.done !== "number" ||
    typeof e.total !== "number"
  ) {
    return undefined;
  }
  return { id, epic: { id: e.id, done: e.done, total: e.total } };
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

// The lit sentinels in a tool_result, whichever shape it arrived in. Nearly no
// result carries one, so a block without the prefix is never joined or scanned —
// this runs over every result of every transcript the daemon parses.
export function resultSentinels(content: unknown): readonly LitSentinel[] {
  if (typeof content === "string") {
    return content.includes(SENTINEL_PREFIX) ? litSentinels(content) : [];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) =>
    typeof b === "object" &&
    b !== null &&
    typeof b.text === "string" &&
    (b.text as string).includes(SENTINEL_PREFIX)
      ? litSentinels(b.text as string)
      : [],
  );
}
