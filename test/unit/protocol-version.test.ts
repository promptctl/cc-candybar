// The protocol check only compares the mirrored spellings of PROTOCOL_VERSION,
// so a bump made in every one passes it. This pin makes each bump a deliberate
// edit; the comment above the constant says why one costs every running session.
import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";

describe("PROTOCOL_VERSION", () => {
  it("changes only by a deliberate edit, because a bump is for a wire change old and new cannot speak across, not for an added request kind", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});
