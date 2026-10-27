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
    // [LAW:no-silent-failure] exception: EPIPE is the reader hanging up —
    // `| head` — which ends the delivery as SIGPIPE ends any other writer,
    // and is not the command's failure to report; the plan's code stands.
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
      } else if ((err as NodeJS.ErrnoException).code === "EPIPE") {
        resolve();
      } else {
        reject(err);
      }
    };
    stream.once("error", settled);
    stream.write(text, settled);
  });

export async function exitWith(plan: CliPlan): Promise<never> {
  // [LAW:nothing-unseen] The delivery's record, on the client's debug channel:
  // what each stream took and the code the process ends with. It rides the
  // plan's own stderr write, so it is waited for like the rest — a line
  // written after the wait would be the one line the exit could drop.
  // Bytes, as `wc -c` counts them, so the record agrees with the reader.
  const record = debugText(
    `delivered stdout=${Buffer.byteLength(plan.stdout)} stderr=${Buffer.byteLength(plan.stderr)} code=${plan.code}`,
  );
  // Both streams settle before anything ends the process: a refusal on one
  // thrown while the other is still in flight would drop that other's tail,
  // the loss this file exists to close. The first refusal is then the
  // command's failure.
  const outcomes = await Promise.allSettled([
    written(process.stdout, plan.stdout),
    written(process.stderr, plan.stderr + record),
  ]);
  for (const o of outcomes) if (o.status === "rejected") throw o.reason;
  process.exit(plan.code);
}
