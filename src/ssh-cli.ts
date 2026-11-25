import type { CliPlan } from "./cli-plan.js";
import { linkKeyId } from "./click/link-signer.js";
import { linkKeyFile, linkKeyFromFile } from "./daemon/link-key.js";
import {
  daemonPaths,
  REMOTE_SOCKET_DIR_UNDER_HOME,
  REMOTE_SOCKET_SUFFIX,
  socketPath,
} from "./daemon/paths.js";
import type { Host } from "./host-facts.js";
import type { Asked } from "./utils/outcome.js";

// What the stanza needs from the machine it runs on: the socket its daemon
// listens on and the id of the key that signs its links.
export interface SshConfigFacts {
  readonly keyId: string;
  readonly socket: string;
}

// [LAW:no-silent-failure] A key this machine cannot have is the command's
// failure, with the reason, never a stanza forwarding to a name nothing signs.
export function sshConfigFacts(host: Host): Asked<SshConfigFacts> {
  const key = linkKeyFromFile(linkKeyFile(daemonPaths(host).state))();
  // [LAW:one-source-of-truth] exception: this command is a client of the daemon
  // run from the user's own shell, so it finds the socket the way every client
  // does, from that shell's environment.
  return key.kind === "ok"
    ? {
        kind: "ok",
        value: { keyId: linkKeyId(key.value), socket: socketPath(host) },
      }
    : key;
}

const USAGE = "Usage: cc-candybar ssh-config ALIAS\n";

// `cc-candybar ssh-config ALIAS`: the lines that make a click on this
// machine's bar, drawn in a terminal on another machine, reach this machine's
// daemon. ALIAS is the `Host` the user's ssh config reaches this machine by,
// which this machine cannot know.
//
// [LAW:one-source-of-truth] A click opens a link on the machine the terminal is
// on, and the daemon that drew it is here. The one thing that crosses is the
// user's own ssh connection, so the forward is the user's ssh config, spelled
// here beside the paths it must agree with (the socket a daemon listens on, the
// name the URL handler opens for a link signed by this machine's key).
export function sshConfigPlan(
  args: readonly string[],
  asked: Asked<SshConfigFacts>,
): CliPlan {
  const [alias, ...extra] = args;
  // [LAW:parse-dont-validate] A Host pattern is one word of ssh's config.
  if (alias === undefined || extra.length > 0 || !/^[^\s#]+$/.test(alias)) {
    return { stdout: "", stderr: USAGE, code: 2 };
  }
  if (asked.kind === "failed") {
    return { stdout: "", stderr: `ssh-config: ${asked.reason}\n`, code: 1 };
  }
  const facts = asked.value;
  const forwardDir = `~/${REMOTE_SOCKET_DIR_UNDER_HOME}`;
  const stanza = [
    "# Run on the machine you sit at, not on this one:",
    `#   mkdir -p -m 700 ${forwardDir}`,
    "# and add this to its ~/.ssh/config. Clicks on this machine's bar then reach",
    "# it while an ssh connection to it is open.",
    `Host ${alias}`,
    "  StreamLocalBindUnlink yes",
    `  LocalForward %d/${REMOTE_SOCKET_DIR_UNDER_HOME}/${facts.keyId}${REMOTE_SOCKET_SUFFIX} ${facts.socket}`,
    "",
  ].join("\n");
  return { stdout: stanza, stderr: "", code: 0 };
}
