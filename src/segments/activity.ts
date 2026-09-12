// What Claude is DOING, folded from the transcript (brandon-activity-ue7).
//
// Three facts, one record: the slash command that opened the current turn, the
// todo list, and the tools in flight plus the ones that finished this turn.
// They are the only class of fact the payload had no shape for — everything else
// it carries is a quantity.
//
// [LAW:one-source-of-truth] The per-entry projection happens ONCE, at the parse
// site (src/utils/transcript-activity.ts), and the incremental machinery lives
// ONCE in the shared fold (src/utils/transcript-fold.ts). What is here is the
// fold's step function and its report projection — the activity-specific part
// and nothing else.
//
// On the ticket's open question — whether this rides the usage store's read or
// re-reads the appended range: neither, exactly. The metrics provider ALREADY
// keeps a second independent cursor over these same bytes, so an independent
// fold is the existing pattern rather than new coupling, and the store's atomic
// cursor+fold pair (the thing not to break) stays untouched. What made
// independence expensive was a second copy of the reset/LRU/mtime policy; that
// is now shared, so independence costs one more bounded, gated tail read of
// O(bytes appended since the last render).

import type { ClaudeHookData, ParsedEntry } from "../utils/claude";
import { isRealUserMessage } from "../utils/claude";
import type { ToolCall, TodoItem } from "../utils/transcript-activity";
import { TranscriptFold } from "../utils/transcript-fold";
import { failed, ok, type Outcome } from "../utils/outcome";

export type { TodoItem } from "../utils/transcript-activity";

// Tools counted by name. Parallel calls of one tool are the common case (three
// Bash calls in one message), and "Bash Bash Bash" reads worse than "Bash×3" on
// a one-line bar — so the count is part of the DATA, not recovered by a display.
export interface ToolTally {
  readonly name: string;
  readonly count: number;
}

// [LAW:types-are-the-program] The reported record. `running` and `done` share one
// shape because they are one question asked at two moments, so one encoder and
// one template helper serve both.
export interface ActivityInfo {
  readonly command: string | null;
  readonly todos: readonly TodoItem[];
  readonly running: readonly ToolTally[];
  readonly done: readonly ToolTally[];
}

// The fold state differs from the report in exactly one way: it keeps tool ids,
// because pairing a `tool_result` to its call is the only thing they are for.
// Reporting tallies them away, so no id crosses the payload seam.
interface ActivityState {
  readonly command: string | null;
  readonly todos: readonly TodoItem[];
  readonly pending: readonly ToolCall[];
  readonly done: readonly ToolTally[];
}

const EMPTY: ActivityState = {
  command: null,
  todos: [],
  pending: [],
  done: [],
};

// [LAW:one-source-of-truth] The one tally increment, used by the fold (as a tool
// completes) and by the report (tallying what is still in flight) — so "counted
// by name, in first-seen order" has a single spelling.
function bump(tally: readonly ToolTally[], name: string): readonly ToolTally[] {
  const at = tally.findIndex((t) => t.name === name);
  if (at < 0) return [...tally, { name, count: 1 }];
  return tally.map((t, i) =>
    i === at ? { name: t.name, count: t.count + 1 } : t,
  );
}

// [LAW:dataflow-not-control-flow] One entry onto the prior state, producing a
// FRESH state. A real user message is the turn boundary: the per-turn facts (the
// command and the tool activity) start over, the todo list does not — it is state
// the user carries across turns until a TodoWrite replaces it.
function step(state: ActivityState, entry: ParsedEntry): ActivityState {
  if (entry.isSidechain) return state;
  const turn = isRealUserMessage(entry)
    ? {
        ...state,
        command: entry.activity?.command ?? null,
        pending: [],
        done: [],
      }
    : state;

  const activity = entry.activity;
  if (activity === undefined) return turn;

  let pending = turn.pending;
  let done = turn.done;
  if (activity.started !== undefined) {
    pending = [...pending, ...activity.started];
  }
  for (const id of activity.finished ?? []) {
    const at = pending.findIndex((call) => call.id === id);
    // A result whose call we never saw: the fold began mid-turn (a /compact
    // rewrite landed between the call and its answer). There is no name to count
    // it under, and the next turn boundary clears the discrepancy — so it is
    // dropped rather than counted as an invented tool.
    if (at < 0) continue;
    done = bump(done, pending[at]!.name);
    pending = [...pending.slice(0, at), ...pending.slice(at + 1)];
  }

  return {
    ...turn,
    pending,
    done,
    todos: activity.todos ?? turn.todos,
  };
}

function report(state: ActivityState): ActivityInfo {
  return {
    command: state.command,
    todos: state.todos,
    running: state.pending.reduce<readonly ToolTally[]>(
      (tally, call) => bump(tally, call.name),
      [],
    ),
    done: state.done,
  };
}

export class ActivityProvider {
  private readonly fold = new TranscriptFold<ActivityState>(EMPTY, step);

  // [LAW:no-silent-failure] A transcript read error is `failed`, carried to the
  // payload boundary that logs it. There is no `absent` arm: a session with no
  // transcript yet, or one that has done nothing, is a real EMPTY record — and
  // the payload projection drops every field of an empty one, so "nothing is
  // happening" reaches the templates as absence either way.
  async getActivityInfo(
    sessionId: string,
    hookData: ClaudeHookData,
  ): Promise<Outcome<ActivityInfo>> {
    const folded = await this.fold.read(sessionId, hookData.transcript_path);
    if (folded.kind === "failed") {
      return failed(`activity (${sessionId}): ${folded.reason}`);
    }
    return ok(report(folded.value));
  }
}
