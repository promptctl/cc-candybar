import os from "node:os";
import type { CliPlan } from "./cli-plan.js";
import { shortHostname } from "./daemon/cache/host-identity.js";
import { REMOTE_SOCKET_DIR_UNDER_HOME, socketPath } from "./daemon/paths.js";
import type { Host } from "./host-facts.js";

// What the stanza needs from the machine it runs on: the socket its daemon
// listens on and the name it is known by. Read by the caller, so the plan is
// pure.
export interface SshConfigFacts {
  readonly hostname: string;
  readonly socket: string;
}

export const sshConfigFacts = (host: Host): SshConfigFacts => ({
  hostname: shortHostname(os.hostname()),
  socket: socketPath(host),
});

// `cc-candybar ssh-config [ALIAS]`: the lines that make a click on this
// machine's bar, drawn in a terminal on another machine, reach this machine's
// daemon.
//
// [LAW:one-source-of-truth] A click opens a link on the machine the terminal is
// on, and the daemon that drew it is here. The one thing that crosses is the
// user's own ssh connection, so the forward is the user's ssh config, spelled
// here beside the paths it must agree with (the socket a daemon listens on, the
// directory the URL handler tries) and not described in a doc that would age.
// The forwarded socket is named by this machine, so two remotes never share one.
export function sshConfigPlan(
  args: readonly string[],
  facts: SshConfigFacts,
): CliPlan {
  const [alias, ...extra] = args;
  if (extra.length > 0) {
    return {
      stdout: "",
      stderr: "Usage: cc-candybar ssh-config [ALIAS]\n",
      code: 2,
    };
  }
  const forwardDir = `~/${REMOTE_SOCKET_DIR_UNDER_HOME}`;
  const stanza = [
    "# Run on the machine you sit at, not on this one:",
    `#   mkdir -p -m 700 ${forwardDir}`,
    "# and add this to its ~/.ssh/config. Clicks on the bar then reach this",
    "# machine while an ssh connection to it is open.",
    `Host ${alias ?? facts.hostname}`,
    "  StreamLocalBindUnlink yes",
    `  LocalForward %d/${REMOTE_SOCKET_DIR_UNDER_HOME}/${facts.hostname}.sock ${facts.socket}`,
    "",
  ].join("\n");
  return { stdout: stanza, stderr: "", code: 0 };
}
