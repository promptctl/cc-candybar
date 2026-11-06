// The link signer (src/click/link-signer.ts): a tmux binding's mac and a
// link's mac are signed over different shapes, so neither stands for the other.

import { TEST_SIGNER } from "../helpers/link-signer";

describe("linkSigner", () => {
  test("a binding's mac verifies for its own socket only, and never as a link's", () => {
    const socket = "/tmp/tmux-501/default";
    const mac = TEST_SIGNER.signBinding(socket);
    expect(TEST_SIGNER.verifyBinding(socket, mac)).toBe(true);
    expect(TEST_SIGNER.verifyBinding(`${socket}x`, mac)).toBe(false);
    expect(TEST_SIGNER.verifyBinding(socket, `${mac}0`)).toBe(false);
    const fields = {
      sessionId: "tmux-status-click",
      action: socket,
      declaration: "",
      evaluated: "",
    };
    expect(TEST_SIGNER.verify(fields, mac)).toBe(false);
    expect(TEST_SIGNER.verifyBinding(socket, TEST_SIGNER.sign(fields))).toBe(false);
  });
});
