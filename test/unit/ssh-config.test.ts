// `cc-candybar ssh-config`: the lines that carry a click from the machine the
// terminal is on to the daemon that drew the bar.

import { sshConfigPlan } from "../../src/ssh-cli";

const facts = {
  kind: "ok",
  value: { keyId: "AbCd-_12", socket: "/tmp/cc-candybar-1000/socket" },
} as const;

describe("cc-candybar ssh-config", () => {
  it("forwards the daemon's socket to the name the URL handler opens for links this machine's key signs", () => {
    const plan = sshConfigPlan(["dev"], facts);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("Host dev\n");
    expect(plan.stdout).toContain("  StreamLocalBindUnlink yes\n");
    expect(plan.stdout).toContain(
      "  LocalForward %d/.cc-candybar/remote/AbCd-_12.sock /tmp/cc-candybar-1000/socket\n",
    );
  });

  it.each([
    ["none", []],
    ["two", ["a", "b"]],
    ["an empty one", [""]],
    ["one with a space", ["my box"]],
  ])("refuses %s as the alias", (_, args) => {
    const plan = sshConfigPlan(args, facts);
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain("Usage: cc-candybar ssh-config ALIAS");
    expect(plan.stdout).toBe("");
  });

  it("says why a key cannot be had, and prints no stanza", () => {
    const plan = sshConfigPlan(["dev"], {
      kind: "failed",
      reason: "link key /x/link.key holds 3 bytes, not 32",
    });
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain("holds 3 bytes");
    expect(plan.stdout).toBe("");
  });
});
