import fs from "node:fs";
import { linkSigner } from "../../src/click/link-signer";
import { linkKeyFile } from "../../src/daemon/link-key";

// The fixed key a test draws and verifies links with, as the daemon does with
// its key file's.
export const TEST_LINK_KEY = Buffer.alloc(32, 7);
export const TEST_SIGNER = linkSigner(TEST_LINK_KEY);

// The test key in a state directory's key file, which a daemon there and the
// CLI both read, so a link a test builds verifies as one the bar drew. A key
// already there is the daemon's own and stays.
export function seedTestLinkKey(stateDir: string): void {
  const file = linkKeyFile(stateDir);
  if (!fs.existsSync(file)) fs.writeFileSync(file, TEST_LINK_KEY);
}
