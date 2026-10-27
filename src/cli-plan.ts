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
import { debug } from "./utils/logger";

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
    const settled = (err?: Error | null): void =>
      err && (err as NodeJS.ErrnoException).code !== "EPIPE"
        ? reject(err)
        : resolve();
    stream.once("error", settled);
    stream.write(text, settled);
  });

export async function exitWith(plan: CliPlan): Promise<never> {
  await Promise.all([
    written(process.stdout, plan.stdout),
    written(process.stderr, plan.stderr),
  ]);
  // [LAW:nothing-unseen] The delivery's record, on the client's debug channel:
  // what each stream took and the code the process ends with.
  debug(
    `delivered stdout=${plan.stdout.length} stderr=${plan.stderr.length} code=${plan.code}`,
  );
  process.exit(plan.code);
}
