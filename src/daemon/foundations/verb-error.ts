import { describeValue } from "../../utils/describe-value.js";

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
  if (thrown instanceof CrossedFailure) return thrown.failure;
  const detail = detailOf(thrown);
  return {
    kind: KINDS.find(([as]) => thrown instanceof as)?.[1] ?? "threw",
    message:
      thrown instanceof Error ? errorText(thrown, "message", "") : detail,
    detail,
  };
}

// [LAW:effects-at-boundaries] A renderer answer records what failed, which
// does not depend on where the runtime put the executing code. Report the
// exception and its explicit fields without inspecting its native stack.
export function rendererFailureOf(thrown: unknown): Failure {
  return classified(thrown, (value) => rendererDetail(value, new Set()));
}

// Error subclasses may expose accessors. Reporting the exception reads only
// authored data, including the built-in error name on its prototype.
function errorText(
  error: Error,
  key: "name" | "message",
  fallback: string,
): string {
  for (
    let source: object | null = error;
    source !== null;
    source = Object.getPrototypeOf(source)
  ) {
    const field = Object.getOwnPropertyDescriptor(source, key);
    if (field) return typeof field.value === "string" ? field.value : fallback;
  }
  return fallback;
}

function rendererDetail(value: unknown, path: Set<Error>): string {
  if (value instanceof CrossedFailure) return value.failure.detail;
  if (!(value instanceof Error))
    return describeValue(value, (error) => rendererDetail(error, path));
  const title = [
    errorText(value, "name", "Error"),
    errorText(value, "message", ""),
  ]
    .filter(Boolean)
    .join(": ");
  if (path.has(value)) return `[Circular: ${title}]`;
  path.add(value);
  const lines = [title];
  const cause = Object.getOwnPropertyDescriptor(value, "cause");
  if (cause && "value" in cause)
    lines.push(`cause: ${rendererDetail(cause.value, path)}`);
  const errors: unknown =
    value instanceof AggregateError
      ? Object.getOwnPropertyDescriptor(value, "errors")?.value
      : undefined;
  if (Array.isArray(errors)) {
    for (let i = 0; i < errors.length; i++) {
      const field = Object.getOwnPropertyDescriptor(errors, i);
      if (field && "value" in field)
        lines.push(`errors[${i}]: ${rendererDetail(field.value, path)}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (
      key === "name" ||
      key === "message" ||
      key === "stack" ||
      key === "cause"
    )
      continue;
    if (key === "errors" && value instanceof AggregateError) continue;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (field !== undefined && "value" in field)
      lines.push(`${key}: ${rendererDetail(field.value, path)}`);
  }
  path.delete(value);
  return lines.join("\n");
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
