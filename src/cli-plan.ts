// [LAW:single-enforcer] The one exit of a one-shot command. Every subcommand
// folds its outcome into a plan — what goes to each stream and the exit code —
// and this is the one place a plan is delivered and the process ends.
//
// [LAW:no-ambient-temporal-coupling] A piped stdout flushes asynchronously
// (macOS; Linux pipes are synchronous), so `process.exit` right after a write
// drops everything past the first 64 KiB the pipe buffered: `daemon-stats
// --json | wc -c` printed exactly 65536. Both streams are waited for through
// their write callbacks, and only then does the process exit, with the code
// the plan carries.

import { peerClosedPipe } from "./proc/pipe";
import process from "node:process";
import { debugText } from "./utils/logger";

// [LAW:dataflow-not-control-flow] The outcome → (streams, exit-code) mapping is
// DATA: each command's fold returns one descriptor, and the two writes and the
// exit run against it unconditionally. Verdicts and bodies on stdout, every
// diagnostic on stderr — so a command in a pipeline yields a parseable body
// while a person still sees the advisories.
export interface CliPlan {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

// Resolves once the stream has taken the text; an empty text resolves too, so
// a plan with nothing on one stream waits on nothing.
const written = (stream: NodeJS.WritableStream, text: string): Promise<void> =>
  new Promise((resolve, reject) => {
    // [LAW:no-silent-failure] exception: a pipe reader can leave early
    // (`| head`). The planned exit code still describes the command.
    // Any other refusal rejects into the command's catch. The stream emits
    // the error as well as passing it to the callback, so the listener is
    // what keeps a hung-up reader from being an unhandled event.
    // A clean write takes its listener off: the streams outlive every delivery
    // a process makes (a test drives many through one worker), and a listener
    // per delivery accumulates on them. A failed write leaves it on, for the
    // emit that follows the callback; `once` removes it then.
    const settled = (err?: Error | null): void => {
      if (!err) {
        stream.off("error", settled);
        resolve();
      } else if (peerClosedPipe(err)) {
        resolve();
      } else {
        reject(err);
      }
    };
    stream.once("error", settled);
    stream.write(text, settled);
  });

// A process exits after both streams settle. Returning its code also lets a
// caller deliver the plan into streams it owns.
export async function deliverPlan(
  plan: CliPlan,
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  // [LAW:nothing-unseen] The delivery's record, on the client's debug channel:
  // what each stream took and the code the process ends with. It rides the
  // plan's own stderr write, so it is waited for like the rest — a line
  // written after the wait would be the one line the exit could drop.
  // The plan's text in bytes, as `wc -c` counts a stream — the record itself
  // rides stderr and is not in its own count.
  const record = debugText(
    () =>
      `delivered stdout=${Buffer.byteLength(plan.stdout)} stderr=${Buffer.byteLength(plan.stderr)} code=${plan.code}`,
  );
  // stdout first and whole, then stderr: issued together, the two writes
  // interleave when the streams share one pipe (`2>&1`), and a diagnostic
  // lands inside the body at the first pipe buffer's edge. Both settle before
  // anything ends the process: a refusal on one thrown while the other is
  // still in flight would drop that other's tail, the loss this file exists
  // to close. The first refusal is then the command's failure.
  const refusals: unknown[] = [];
  for (const [stream, text] of [
    [streams.stdout, plan.stdout],
    [streams.stderr, plan.stderr + record],
  ] as const) {
    await written(stream, text).catch((e: unknown) => refusals.push(e));
  }
  if (refusals.length > 0) throw refusals[0];
  return plan.code;
}

export async function exitWith(plan: CliPlan): Promise<never> {
  process.exit(await deliverPlan(plan, process));
}
