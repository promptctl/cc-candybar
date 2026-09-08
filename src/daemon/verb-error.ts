// [LAW:types-are-the-program] The dispatcher routes this by `instanceof` to BAD_REQUEST, any other Error to RENDER_FAILED.
export class BadVerbArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadVerbArgs";
  }
}
