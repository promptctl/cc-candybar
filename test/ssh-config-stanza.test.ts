// [LAW:verifiable-goals] The forward's file name is what ssh makes of the
// stanza, not what its text reads as: `%n` is the alias the user typed, and the
// URL handler opens the file that results.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sshConfigPlan } from "../src/ssh-cli";

const facts = {
  kind: "ok",
  value: { keyId: "AbCd-_12", socket: "/tmp/cc-candybar-1000/socket" },
} as const;

test("ssh expands the stanza to a forward named by the key and the alias", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-ssh-g-"));
  try {
    const config = path.join(dir, "config");
    fs.writeFileSync(config, sshConfigPlan(["web.eu-1"], facts).stdout);
    const expanded = execFileSync("ssh", ["-G", "-F", config, "web.eu-1"], {
      encoding: "utf8",
    });
    expect(expanded).toContain(
      `localforward ${os.homedir()}/.cc-candybar/remote/AbCd-_12.web.eu-1.sock /tmp/cc-candybar-1000/socket\n`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
