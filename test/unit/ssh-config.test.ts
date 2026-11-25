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
      "  LocalForward %d/.cc-candybar/remote/AbCd-_12.%n.sock /tmp/cc-candybar-1000/socket\n",
    );
  });

  it.each([
    ["none", []],
    ["two", ["a", "b"]],
  ])("refuses %s as the alias with the usage", (_, args) => {
    const plan = sshConfigPlan(args, facts);
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain("Usage: cc-candybar ssh-config ALIAS");
    expect(plan.stdout).toBe("");
  });

  it.each([
    ["an empty one", ""],
    ["one with a space", "my box"],
    ["a pattern", "*"],
    ["a negation", "!dev"],
    ["one that is an option", "-oProxyCommand=x"],
    ["one with a comment mark", "dev#"],
    ["one that is a path", "a/b"],
  ])("refuses %s as the alias, naming the word and the spelling", (_, word) => {
    const plan = sshConfigPlan([word], facts);
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain(JSON.stringify(word));
    expect(plan.stderr).toContain("letters, digits, _, . and -");
    expect(plan.stdout).toBe("");
  });

  it("leaves the forward's directory to install, the one creator that checks it", () => {
    const { stdout } = sshConfigPlan(["dev"], facts);
    expect(stdout).toContain("cc-candybar install");
    expect(stdout).not.toContain("mkdir");
  });

  it("says why the daemon's key cannot be had, and prints no stanza", () => {
    const plan = sshConfigPlan(["dev"], {
      kind: "failed",
      reason: "no daemon answered on /tmp/x/socket",
    });
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain("no daemon answered");
    expect(plan.stdout).toBe("");
  });

  it.each(["/tmp/a b/socket", "/tmp/100%/socket"])(
    "refuses a socket ssh's config cannot carry: %s",
    (socket) => {
      const plan = sshConfigPlan(["dev"], {
        kind: "ok",
        value: { keyId: "AbCd-_12", socket },
      });
      expect(plan.code).toBe(1);
      expect(plan.stderr).toContain("CC_CANDYBAR_SOCKET");
      expect(plan.stdout).toBe("");
    },
  );
});
