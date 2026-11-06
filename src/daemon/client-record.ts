// `cc-candybar record <session-id> <path> [--seconds N]`: a session's stream
// written out of the running daemon as a recording, for a bug report — the
// file `pnpm demo --recording` replays frame by frame. Does NOT spawn a
// daemon: a session's stream lives in the daemon that draws its bar.

import { resolve } from "node:path";
import type { CliPlan } from "../cli-plan";
import {
  describeFailure,
  requestOutcome,
  type ClientWorld,
  type RoundTripOutcome,
} from "./client-transport";
import { parseRecordSeconds, type Recorded } from "./protocol";

export const DEFAULT_RECORD_SECONDS = 10;

// The connect is an operator's, as daemon-stats' is; the round trip lasts the
// recording, with room for the daemon to close the file and answer.
const CONNECT_MS = 200;
const ANSWER_MARGIN_MS = 2000;

export interface RecordArgs {
  readonly session: string;
  readonly path: string;
  readonly seconds: number;
}

// [LAW:parse-dont-validate] The command's arguments, parsed once. The path is
// resolved here against the shell's directory: the daemon's own is no
// client's. The session id is the daemon's to judge, by the one checkpoint
// every session id crosses.
export function parseRecordArgs(
  args: readonly string[],
  cwd: string,
):
  | { readonly ok: true; readonly args: RecordArgs }
  | { readonly ok: false; readonly problem: string } {
  const positional: string[] = [];
  let seconds = DEFAULT_RECORD_SECONDS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--seconds") {
      const given = args[++i];
      if (given === undefined) {
        return { ok: false, problem: "--seconds needs a number after it" };
      }
      const span = parseRecordSeconds(Number(given));
      if (!span.ok) {
        return {
          ok: false,
          problem: `--seconds ${JSON.stringify(given)} ${span.problem}`,
        };
      }
      seconds = span.seconds;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      positional.push(arg);
    } else {
      return {
        ok: false,
        problem: `unexpected argument ${JSON.stringify(arg)}`,
      };
    }
  }
  const [session, path, ...extra] = positional;
  if (session === undefined || path === undefined || extra.length > 0) {
    return {
      ok: false,
      problem: "usage: cc-candybar record <session-id> <path> [--seconds N]",
    };
  }
  return { ok: true, args: { session, path: resolve(cwd, path), seconds } };
}

// [LAW:dataflow-not-control-flow] The outcome → (streams, exit-code) fold.
// [LAW:no-silent-failure] A recording no request was answered in replays nothing,
// so it is a failure the person running the command hears now, not one the
// reader of the report finds later.
export function recordPlan(
  outcome: RoundTripOutcome<Recorded>,
  seconds: number,
): CliPlan {
  if (outcome.kind !== "ok") {
    return {
      stdout: "",
      stderr: `record: ${describeFailure(outcome)}\n`,
      code: 1,
    };
  }
  const { path, lines, answers, daemonClosed } = outcome.value;
  // A span the daemon's close cut short is said, so a short file or an empty
  // one is never read as the session's own doing.
  const cut = `the daemon closed before ${seconds}s ran out`;
  return answers === 0
    ? {
        stdout: "",
        stderr: daemonClosed
          ? `record: ${path}: ${cut}, and no request had been answered, so there is nothing to replay. No file was left.\n`
          : `record: ${path}: no request was answered in ${seconds}s, so there is nothing to replay: the session was idle, or its statusline is not drawn by this daemon. No file was left.\n`,
        code: 1,
      }
    : {
        stdout: `${path}: ${lines} lines, ${answers} answers\n`,
        stderr: daemonClosed
          ? `record: ${cut}: the file holds what came before.\n`
          : "",
        code: 0,
      };
}

export async function recordCommandPlan(
  world: ClientWorld,
  args: readonly string[],
  cwd: string,
): Promise<CliPlan> {
  const parsed = parseRecordArgs(args, cwd);
  if (!parsed.ok)
    return { stdout: "", stderr: `record: ${parsed.problem}\n`, code: 2 };
  const { session, path, seconds } = parsed.args;
  // [LAW:no-defensive-null-guards] exception: trust boundary. The response is
  // an unchecked cast from socket JSON; the presence check is the narrowing
  // at the wire edge, as daemon-stats' is.
  const outcome = await requestOutcome(
    world,
    () => ({ kind: "record", session, path, seconds }),
    { connectMs: CONNECT_MS, budgetMs: seconds * 1000 + ANSWER_MARGIN_MS },
    (resp) => ("recorded" in resp ? resp.recorded : undefined),
  );
  return recordPlan(outcome, seconds);
}
