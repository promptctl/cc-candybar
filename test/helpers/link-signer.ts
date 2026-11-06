import { linkSigner } from "../../src/click/link-signer";
import type { RendererLinks } from "../../src/click/renderer-links";
import { MAIN_NAME } from "../../src/daemon/home";

// The fixed key a test draws and verifies `run` links with, as the daemon does
// with its key file's.
export const TEST_LINK_KEY = Buffer.alloc(32, 7);
export const TEST_SIGNER = linkSigner(TEST_LINK_KEY);
// A test's links are the main renderer's, signed with the fixed key.
export const TEST_LINKS: RendererLinks = { to: MAIN_NAME, signer: TEST_SIGNER };
