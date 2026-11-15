import { linkSigner } from "../../src/click/link-signer";

// The fixed key a test draws and verifies `run` links with, as the daemon does
// with its key file's.
export const TEST_LINK_KEY = Buffer.alloc(32, 7);
export const TEST_SIGNER = linkSigner(TEST_LINK_KEY);

// A click request for `verb` and its still-encoded `value`, over the link a
// bar signed with the test key would carry.
export const signedClick = (verb: string, value: string) =>
  ({
    kind: "click",
    url: TEST_SIGNER.signLink(`cc-candybar://${verb}/${value}`),
  }) as const;
