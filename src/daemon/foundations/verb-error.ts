import {
  describeValue,
  errorMessage,
  isReportedError,
  UNINSPECTABLE,
} from "../../utils/describe-value.js";

// [LAW:types-are-the-program] Argument-shape failures are structurally
// distinct from operational failures. `failureOf` classifies a thrown value
// by its class, once, where it was thrown: BadVerbArgs is a bad request and
// any other Error the daemon's failure (RENDER_FAILED).
// [LAW:one-way-deps] Lives below both the verb handlers and the config-file
// store, so a store refusal ("this click no longer fits the file") carries
// the same classification a handler's own argument check does.
export class BadVerbArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadVerbArgs";
  }
}

// The daemon closed while this click waited or ran. No failure of the click's
// own: its own outcome at the reply, and nothing more of it runs.
export class DaemonClosing extends Error {
  constructor(verb: string) {
    super(`the daemon closed: ${verb} refused`);
    this.name = "DaemonClosing";
  }
}

// The client left before this click's turn came, so it never ran.
export class ClickAbandoned extends Error {
  constructor(verb: string) {
    super(`the client left: ${verb} not run`);
    this.name = "ClickAbandoned";
  }
}

// No renderer is live to take the input: the last one ended, and its
// supervisor says how, once, rather than each input that found none.
export class RendererDown extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendererDown";
  }
}

// [LAW:types-are-the-program] How a request or a turn failed, as data: its
// kind, which a request's outcome is named by and its reader routes by
// (`bad-request` the client's fault, `threw` the daemon's, and the others
// neither: a close, a client that left, no renderer live), the message a
// reply carries, and the detail a log keeps. A class crosses no process,
// so a failure is classified where it was thrown and travels as this.
export interface Failure {
  readonly kind: "bad-request" | "threw" | "closing" | "abandoned" | "down";
  readonly message: string;
  readonly detail: string;
}

// [LAW:single-enforcer] An argument failure inside a checked render is a
// daemon bug. Closing, abandonment and renderer availability retain their
// own outcomes even though the wire uses the same failure envelope.
export const renderFailure = (failure: Failure): Failure =>
  failure.kind === "bad-request" ? { ...failure, kind: "threw" } : failure;

// [LAW:dataflow-not-control-flow] The kind each Error is thrown as; anything
// else the daemon threw.
const KINDS: ReadonlyArray<
  readonly [abstract new (...args: never[]) => Error, Failure["kind"]]
> = [
  [BadVerbArgs, "bad-request"],
  [DaemonClosing, "closing"],
  [ClickAbandoned, "abandoned"],
  [RendererDown, "down"],
];

export function failureKindOf(raw: unknown): Failure["kind"] | undefined {
  return raw === "threw" ? raw : KINDS.find(([, kind]) => raw === kind)?.[1];
}

// A failure classified in another process, thrown here as it was classified
// there: a class crosses no process, so the failure travels as data and is
// thrown again as this.
export class CrossedFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
    this.name = "CrossedFailure";
  }
}

// [LAW:single-enforcer] A crossed failure was classified where it was
// thrown, so it keeps both its kind and its original detail.
export function classified(
  thrown: unknown,
  detailOf: (value: unknown) => string,
): Failure {
  try {
    if (thrown instanceof CrossedFailure) return thrown.failure;
    const detail = detailOf(thrown);
    return {
      kind: KINDS.find(([as]) => thrown instanceof as)?.[1] ?? "threw",
      message: isReportedError(thrown) ? errorMessage(thrown) : detail,
      detail,
    };
  } catch {
    return { kind: "threw", message: UNINSPECTABLE, detail: UNINSPECTABLE };
  }
}

// [LAW:effects-at-boundaries] A renderer answer records what failed, which
// does not depend on where the runtime put the executing code. Report the
// exception and its explicit fields without inspecting its native stack.
export function rendererFailureOf(thrown: unknown): Failure {
  return classified(thrown, (value) =>
    describeValue(value, (error) =>
      error instanceof CrossedFailure ? error.failure.detail : undefined,
    ),
  );
}

// A request refused for what it carried, nothing having thrown.
export function badRequest(...problems: readonly string[]): Failure {
  const message = problems.join("; ");
  return { kind: "bad-request", message, detail: message };
}

// [LAW:single-enforcer] One boundary reclassifies malformed wire encoding.
// percent-decoding untrusted wire input throws a raw URIError on a bad escape
// (`%ZZ`, a lone `%`); that is an argument-shape failure, not an operational
// one, so it must reach the dispatcher as BadVerbArgs (→ BAD_REQUEST) like every
// other bad-input shape. Every decode of a click's wire value (the verb codecs,
// the verb of a link a status-line click runs) funnels through here so the
// reclassification lives once.
export function decodeWire<T>(decode: () => T): T {
  try {
    return decode();
  } catch (err) {
    if (err instanceof URIError)
      throw new BadVerbArgs(`malformed wire encoding: ${err.message}`);
    throw err;
  }
}
