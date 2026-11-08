import { modelIdOf } from "../src/segments/pricing";

describe("modelIdOf", () => {
  // [LAW:one-source-of-truth] An empty entry model names no model, so the
  // message's model prices the entry, as it does when the entry has none.
  it("reads the message's model when the entry's model is empty", () => {
    expect(
      modelIdOf({ model: "", message: { model: "claude-opus-4-5-20251101" } }),
    ).toBe("claude-opus-4-5-20251101");
  });

  it("reads the entry's model when it names one", () => {
    expect(
      modelIdOf({
        model: "claude-haiku-4-5",
        message: { model: "claude-opus-4-5-20251101" },
      }),
    ).toBe("claude-haiku-4-5");
  });
});
