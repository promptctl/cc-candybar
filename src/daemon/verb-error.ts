// [LAW:types-are-the-program] Argument-shape failures are structurally
// distinct from operational failures. The dispatcher uses `instanceof` to
// route BadVerbArgs to BAD_REQUEST and any other Error to RENDER_FAILED.
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
