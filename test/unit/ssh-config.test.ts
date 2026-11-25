// `cc-candybar ssh-config`: the lines that carry a click from the machine the
// terminal is on to the daemon that drew the bar.

import { sshConfigPlan } from "../../src/ssh-cli";

const facts = { hostname: "devbox", socket: "/tmp/cc-candybar-1000/socket" };

describe("cc-candybar ssh-config", () => {
  it("forwards the daemon's socket into the directory the URL handler tries, named by this machine", () => {
    const plan = sshConfigPlan([], facts);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("Host devbox\n");
    expect(plan.stdout).toContain("  StreamLocalBindUnlink yes\n");
    expect(plan.stdout).toContain(
      "  LocalForward %d/.cc-candybar/remote/devbox.sock /tmp/cc-candybar-1000/socket\n",
    );
  });

  it("names the Host the user reaches this machine by when given one", () => {
    expect(sshConfigPlan(["dev"], facts).stdout).toContain("Host dev\n");
  });

  it("refuses more than one alias", () => {
    const plan = sshConfigPlan(["a", "b"], facts);
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain("Usage: cc-candybar ssh-config");
  });
});
