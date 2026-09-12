// What the transcript says Claude is DOING — the one class of fact the render
// payload had no shape for (brandon-activity-ue7). Everything else the payload
// carries is a quantity: cost, tokens, percentages, counts. Nothing said which
// tool was running, what the todo list was, or which slash command opened the
// turn.
//
// [LAW:one-source-of-truth] These facts live inside `message.content[]`, which
// `makeEntry` deliberately does NOT retain — those arrays are the multi-MB LLM
// text the pruning exists to drop. So this module is a PROJECTION run at the one
// parse site, in exactly the shape `firstContentType` already established:
// project the bounded scalars, never the array. A tool call keeps its id and
// name (29 + ~8 bytes), a tool result keeps only the id it answers, a TodoWrite
// keeps its list (bounded by the list), and a slash command keeps its name. The
// content arrays stay unreachable from here on, as before.

// One tool call, as the transcript names it. The id is retained for exactly one
// reason: it is the only thing that pairs a `tool_result` back to the call it
// answers, and a statusline that showed `Read` running while `Bash` was the one
// in flight would be worse than showing nothing.
export interface ToolCall {
  readonly id: string;
  readonly name: string;
}

// [LAW:types-are-the-program] A todo item projected to the two predicates any
// reader asks — is this the one in progress, and is it finished. The transcript
// spells a third status (`pending`), and Claude Code may spell a fourth one day;
// an unrecognised status is honestly neither active nor done, so this projection
// stays TRUE across a vocabulary change instead of guessing an arm for it.
//
// `text` selects between the transcript's two names for one task: `content`
// ("Write the gate") and `activeForm` ("Writing the gate") are the same fact in
// two grammars, and the item's own status is what decides which grammar reads
// correctly — so the selection is a property of the item, not of a display.
export interface TodoItem {
  readonly text: string;
  readonly active: boolean;
  readonly done: boolean;
}

// [LAW:types-are-the-program] A record of independently-optional contributions,
// not a union: one entry can genuinely be several of these at once — a TodoWrite
// call is BOTH a started tool and a todo list — so a union arm per kind would be
// a false theorem. Absent means "this entry contributes nothing of that kind",
// and `entryActivity` returns undefined when every field is absent, so the vast
// majority of entries (assistant text, usage-only lines) retain nothing new.
export interface EntryActivity {
  readonly started?: readonly ToolCall[];
  readonly finished?: readonly string[];
  readonly todos?: readonly TodoItem[];
  readonly command?: string;
}

// Claude Code writes a slash command into the transcript as the user turn's own
// text, wrapped in a `<command-name>` tag (verified against ~300 real
// transcripts: 255 occurrences, every one of them in a string `content`, none as
// a text block — both forms are read anyway, since one is free).
const COMMAND_NAME = /<command-name>\s*([^<\s][^<]*?)\s*<\/command-name>/;

function slashCommand(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  return COMMAND_NAME.exec(text)?.[1];
}

function todoItems(input: unknown): readonly TodoItem[] | undefined {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const items: TodoItem[] = [];
  for (const raw of todos) {
    if (typeof raw !== "object" || raw === null) continue;
    const { content, activeForm, status } = raw as Record<string, unknown>;
    const active = status === "in_progress";
    const text =
      active && typeof activeForm === "string" ? activeForm : content;
    if (typeof text !== "string") continue;
    items.push({ text, active, done: status === "completed" });
  }
  return items;
}

/**
 * Project one parsed transcript line's activity, or undefined when it has none.
 *
 * [LAW:no-control-flow-on-union-kind] ONE total switch over the content-block
 * kind, accumulating DATA — the discrimination happens once, here, at the parse
 * site, and no consumer downstream re-asks what kind of block something was.
 */
export function entryActivity(
  parsed: Record<string, unknown>,
): EntryActivity | undefined {
  const msg = parsed.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  // A `<command-name>` tag is only this turn's command when the USER wrote it;
  // an assistant echoing the tag back is discussing a command, not running one.
  const isUser = parsed.type === "user";

  const started: ToolCall[] = [];
  const finished: string[] = [];
  let todos: readonly TodoItem[] | undefined;
  // The turn's own prose, whichever shape it arrived in — a bare string or the
  // first text block. The user check is applied ONCE, to the result, so the two
  // shapes cannot end up under two different rules.
  let turnText: unknown;

  if (typeof content === "string") {
    turnText = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case "tool_use": {
          const { id, name } = b;
          if (typeof id !== "string" || typeof name !== "string") break;
          started.push({ id, name });
          // The todo list rides its own tool call's input. A later block in the
          // same entry supersedes an earlier one: it is the newer state.
          if (name === "TodoWrite") todos = todoItems(b.input) ?? todos;
          break;
        }
        case "tool_result": {
          const id = b.tool_use_id;
          if (typeof id === "string") finished.push(id);
          break;
        }
        case "text": {
          turnText ??= b.text;
          break;
        }
        default:
          break;
      }
    }
  }

  const command = isUser ? slashCommand(turnText) : undefined;

  // [LAW:polishing-by-subtraction] Undefined when there is nothing to say, so
  // the whole-tree cost scan retains not one extra byte for the entries it folds
  // (assistant text and usage lines carry no activity at all).
  if (
    started.length === 0 &&
    finished.length === 0 &&
    todos === undefined &&
    command === undefined
  ) {
    return undefined;
  }
  return {
    ...(started.length > 0 && { started }),
    ...(finished.length > 0 && { finished }),
    ...(todos !== undefined && { todos }),
    ...(command !== undefined && { command }),
  };
}
