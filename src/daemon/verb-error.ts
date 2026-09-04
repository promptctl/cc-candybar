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
