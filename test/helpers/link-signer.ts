import { linkSigner } from "../../src/click/link-signer";

// The fixed key a test draws and verifies `run` links with, as the daemon does
// with its key file's.
export const TEST_LINK_KEY = Buffer.alloc(32, 7);
export const TEST_SIGNER = linkSigner(TEST_LINK_KEY);
