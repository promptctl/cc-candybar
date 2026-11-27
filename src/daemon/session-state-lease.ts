// [LAW:single-enforcer] Socket paths can be overridden independently of the
// state directory. The process that imports, journals or exports this
// directory must be its only writer throughout that work.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { publishByRename } from "../utils/atomic-write.js";
import { readLease } from "./socket-lease.js";
import {
  liveness,
  type ProcessIdentity,
  type ProcessProbe,
} from "./process-fingerprint.js";

export async function claimSessionState(
  state: string,
  owner: ProcessIdentity,
  probe: ProcessProbe,
): Promise<() => void> {
  const dir = path.join(state, "shared-session", "owners");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Each contender publishes a unique complete claim before looking for
  // others. Two simultaneous claimants can both decline. They cannot both
  // pass. A collector can only remove a dead owner's unique file.
  const file = path.join(dir, randomUUID() + ".owner");
  publishByRename(file, JSON.stringify(owner), 0o600);
  const release = () => fs.rmSync(file, { force: true });
  try {
    for (const entry of fs.readdirSync(dir)) {
      const other = path.join(dir, entry);
      if (other === file || !entry.endsWith(".owner")) continue;
      const claim = readLease(other);
      if (claim.kind === "absent") continue;
      if (claim.kind === "unreadable")
        throw new Error(
          `cannot verify the owner of session state at ${other}: ${claim.detail}`,
        );
      const seen = await liveness(claim.pid, claim.startTime, probe);
      if (seen.live)
        throw new Error(
          `session state at ${state} is in use by pid=${claim.pid} (${seen.why})`,
        );
      fs.rmSync(other, { force: true });
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
