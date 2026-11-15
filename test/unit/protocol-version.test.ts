// [LAW:types-are-the-program] PROTOCOL_VERSION says that old and new cannot
// speak across, and nothing else. The protocol check only compares the two
// runtimes' spellings, so a bump made in both passes it; this pin makes every
// bump a deliberate edit, because each one answers every running session's
// client with a version mismatch until that session restarts.
import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";

describe("PROTOCOL_VERSION", () => {
  it("moves only for a wire change old and new cannot speak across, never for an added request kind", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});
