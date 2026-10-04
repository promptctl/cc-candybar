// A few turns of Claude Code, as data: what the Status hook reports, what the
// transcript gains and what the repository does, at each moment. The player
// (transport.ts) applies a step when its moment comes; nothing here renders.
//
// Every number is one Claude Code itself would send: context and cost from the
// hook, tools and todos from the transcript's tool_use / tool_result blocks,
// the turn boundary from a real user message.

import type { RepoState } from "./world";

/**
 * The repository as the scenario describes it: HEAD's commit time is a moment
 * of the scenario (seconds from its start, negative before it), which the
 * player turns into a time on the clock when the step happens, so a replay's
 * commit is as fresh as the first one's.
 */
export type ScenarioRepo = Omit<RepoState, "headTime"> & { readonly headAt: number };

export interface Moment {
  /** Context tokens in use (of a 200K window). */
  readonly context?: number;
  readonly costUsd?: number;
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
  /** The 5-hour and 7-day rate-limit windows, percent used. */
  readonly fiveHour?: number;
  readonly sevenDay?: number;
}

export interface Step {
  /** Seconds from the start of the scenario. */
  readonly at: number;
  /** 0 before the first turn. */
  readonly turn: number;
  readonly caption: string;
  readonly hook?: Moment;
  readonly transcript?: readonly Entry[];
  readonly repo?: Partial<ScenarioRepo>;
}

// What a transcript line says, before the player stamps it with a time and ids.
export type Entry =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "command"; readonly name: string }
  | { readonly kind: "tools"; readonly calls: readonly Call[]; readonly output?: number }
  | { readonly kind: "results"; readonly ids: readonly string[] }
  | { readonly kind: "reply"; readonly text: string; readonly output?: number };

export interface Call {
  readonly id: string;
  readonly name: string;
  readonly input?: object;
}

export const INITIAL_REPO: ScenarioRepo = {
  branch: "fix-cache-timer",
  ahead: 0,
  behind: 0,
  modified: [],
  untracked: ["notes.md"],
  headAt: -3 * 3600,
  head: "4f2c9e1b7a0d3c5e8f6a2b4d1c7e9f0a3b5d7c21",
};

export const INITIAL_MOMENT: Required<Moment> = {
  context: 18_000,
  costUsd: 0.04,
  linesAdded: 0,
  linesRemoved: 0,
  fiveHour: 41,
  sevenDay: 47,
};

const todos = (...items: [string, string, "pending" | "in_progress" | "completed"][]): Call => ({
  id: `todo-${items.map((i) => i[2][0]).join("")}`,
  name: "TodoWrite",
  input: { todos: items.map(([content, activeForm, status]) => ({ content, activeForm, status })) },
});

export const STEPS: readonly Step[] = [
  { at: 0, turn: 0, caption: "A fresh session in ~/code/tidepool, on a branch with one untracked file" },

  // Turn 1: a real bug, worked end to end.
  { at: 3, turn: 1, caption: "You ask Claude to fix a flaky test", hook: { context: 21_000 },
    transcript: [{ kind: "user", text: "The cache timer test is flaky. Find out why and fix it." }] },
  { at: 5, turn: 1, caption: "Claude writes a todo list", hook: { context: 24_000, costUsd: 0.09 },
    transcript: [{ kind: "tools", output: 220, calls: [todos(
      ["Reproduce the flake", "Reproducing the flake", "in_progress"],
      ["Find the race", "Finding the race", "pending"],
      ["Fix it and re-run the tests", "Fixing it", "pending"])] }, { kind: "results", ids: ["todo-ipp"] }] },
  { at: 7, turn: 1, caption: "…and reads two files at once", hook: { context: 26_000, costUsd: 0.12 },
    transcript: [{ kind: "tools", output: 90, calls: [
      { id: "read-1", name: "Read", input: { file_path: "src/cache.ts" } },
      { id: "read-2", name: "Read", input: { file_path: "test/cache.test.ts" } }] }] },
  { at: 10, turn: 1, caption: "The reads come back", hook: { context: 34_000, costUsd: 0.18 },
    transcript: [{ kind: "results", ids: ["read-1", "read-2"] }] },
  { at: 12, turn: 1, caption: "Claude runs the test to see it fail", hook: { context: 35_000, costUsd: 0.21 },
    transcript: [{ kind: "tools", output: 60, calls: [{ id: "bash-1", name: "Bash", input: { command: "pnpm test cache" } }] }] },
  { at: 17, turn: 1, caption: "It fails one run in four: on to the race", hook: { context: 41_000, costUsd: 0.27 },
    transcript: [{ kind: "results", ids: ["bash-1"] }, { kind: "tools", output: 180, calls: [todos(
      ["Reproduce the flake", "Reproducing the flake", "completed"],
      ["Find the race", "Finding the race", "in_progress"],
      ["Fix it and re-run the tests", "Fixing it", "pending"])] }, { kind: "results", ids: ["todo-cip"] }] },
  { at: 20, turn: 1, caption: "Claude searches for every use of the clock", hook: { context: 43_000, costUsd: 0.31 },
    transcript: [{ kind: "tools", output: 70, calls: [{ id: "grep-1", name: "Grep", input: { pattern: "Date.now" } }] }] },
  { at: 22, turn: 1, caption: "Found it: the test reads the wall clock twice", hook: { context: 46_000, costUsd: 0.36 },
    transcript: [{ kind: "results", ids: ["grep-1"] }] },
  { at: 24, turn: 1, caption: "Claude edits src/cache.ts, and the repository is dirty", hook: { context: 48_000, costUsd: 0.42, linesAdded: 9, linesRemoved: 4 },
    transcript: [{ kind: "tools", output: 400, calls: [{ id: "edit-1", name: "Edit", input: { file_path: "src/cache.ts" } }] }],
    repo: { modified: ["src/cache.ts"] } },
  { at: 26, turn: 1, caption: "The edit lands", transcript: [{ kind: "results", ids: ["edit-1"] }] },
  { at: 27, turn: 1, caption: "Claude re-runs the tests", hook: { context: 49_000, costUsd: 0.45 },
    transcript: [{ kind: "tools", output: 60, calls: [{ id: "bash-2", name: "Bash", input: { command: "pnpm test" } }] }] },
  { at: 33, turn: 1, caption: "All green, todos done", hook: { context: 55_000, costUsd: 0.53, fiveHour: 46 },
    transcript: [{ kind: "results", ids: ["bash-2"] }, { kind: "tools", output: 150, calls: [todos(
      ["Reproduce the flake", "Reproducing the flake", "completed"],
      ["Find the race", "Finding the race", "completed"],
      ["Fix it and re-run the tests", "Fixing it", "completed"])] }, { kind: "results", ids: ["todo-ccc"] }] },
  { at: 35, turn: 1, caption: "Claude explains the fix and stops", hook: { context: 57_000, costUsd: 0.58 },
    transcript: [{ kind: "reply", output: 520, text: "Fixed: the test read Date.now() twice across a tick boundary." }] },

  // Turn 2: a slash command.
  { at: 39, turn: 2, caption: "You type /compact", transcript: [{ kind: "command", name: "/compact" }] },
  { at: 43, turn: 2, caption: "The conversation is summarised: context drops", hook: { context: 13_000, costUsd: 0.63 },
    transcript: [{ kind: "reply", output: 900, text: "Summary of the conversation so far." }] },

  // Turn 3: commit and push.
  { at: 47, turn: 3, caption: "You ask for a commit and a push", hook: { context: 15_000 },
    transcript: [{ kind: "user", text: "Commit it and push." }] },
  { at: 49, turn: 3, caption: "Claude commits", hook: { context: 17_000, costUsd: 0.66 },
    transcript: [{ kind: "tools", output: 80, calls: [{ id: "bash-3", name: "Bash", input: { command: "git commit -am 'fix(cache): read the clock once'" } }] }] },
  { at: 52, turn: 3, caption: "Clean, one commit ahead of origin", hook: { context: 18_000, costUsd: 0.68 },
    transcript: [{ kind: "results", ids: ["bash-3"] }],
    repo: { modified: [], ahead: 1, head: "9b1e3d5f7a2c4e6b8d0f1a3c5e7b9d2f4a6c8e01", headAt: 50 } },
  { at: 54, turn: 3, caption: "Claude pushes", transcript: [{ kind: "tools", output: 60, calls: [{ id: "bash-4", name: "Bash", input: { command: "git push" } }] }] },
  { at: 58, turn: 3, caption: "Pushed: level with origin", hook: { context: 20_000, costUsd: 0.71, fiveHour: 48 },
    transcript: [{ kind: "results", ids: ["bash-4"] }, { kind: "reply", output: 120, text: "Committed and pushed." }],
    repo: { ahead: 0 } },

  // Turn 4: a big job, to show the limits colour as they fill.
  { at: 62, turn: 4, caption: "You ask for a large refactor", hook: { context: 23_000 },
    transcript: [{ kind: "user", text: "Now move the whole storage layer onto the new cache." }] },
  { at: 64, turn: 4, caption: "Claude reads widely: three agents at once", hook: { context: 61_000, costUsd: 1.1, fiveHour: 58 },
    transcript: [{ kind: "tools", output: 300, calls: [
      { id: "task-1", name: "Task" }, { id: "task-2", name: "Task" }, { id: "task-3", name: "Task" }] }] },
  { at: 69, turn: 4, caption: "Context passes half the window", hook: { context: 112_000, costUsd: 1.9, fiveHour: 71, sevenDay: 52 } },
  { at: 74, turn: 4, caption: "The 5-hour window turns to warning", hook: { context: 141_000, costUsd: 2.6, fiveHour: 83 },
    transcript: [{ kind: "results", ids: ["task-1", "task-2", "task-3"] }, { kind: "tools", output: 900, calls: [
      { id: "edit-2", name: "Edit" }, { id: "edit-3", name: "Edit" }, { id: "edit-4", name: "Edit" }, { id: "edit-5", name: "Edit" }] }],
    repo: { modified: ["src/storage/index.ts", "src/storage/disk.ts", "src/cache.ts"] } },
  { at: 80, turn: 4, caption: "Context is nearly full: time to /compact again", hook: { context: 176_000, costUsd: 3.4, fiveHour: 91, sevenDay: 55, linesAdded: 214, linesRemoved: 167 },
    transcript: [{ kind: "results", ids: ["edit-2", "edit-3", "edit-4", "edit-5"] }] },
  { at: 86, turn: 4, caption: "The end. Replay, or click around the bar", hook: { context: 178_000, costUsd: 3.5 },
    transcript: [{ kind: "reply", output: 700, text: "The storage layer now uses the new cache." }] },
];

export const DURATION = 90;
