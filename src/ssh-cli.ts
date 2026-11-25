import type { CliPlan } from "./cli-plan.js";
import {
  describeFailure,
  type ClientWorld,
} from "./daemon/client-transport.js";
import { fetchStats } from "./daemon/client-stats.js";
import {
  REMOTE_SOCKET_DIR_UNDER_HOME,
  REMOTE_SOCKET_SUFFIX,
  socketPath,
} from "./daemon/paths.js";
import type { Asked } from "./utils/outcome.js";

// What the stanza needs from the machine it runs on: the socket its daemon
// listens on and the id of the key that daemon signs its links with.
export interface SshConfigFacts {
  readonly keyId: string;
  readonly socket: string;
}

// [LAW:one-source-of-truth] The id is the running daemon's own answer, asked
// over the socket the stanza forwards to, so the two cannot disagree: the
// daemon is detached and keeps the key it loaded, wherever its environment
// pointed. [LAW:no-silent-failure] No daemon to ask, or one that cannot say, is
// the command's failure with the reason, never a stanza naming a key nothing
// signs with.
export async function sshConfigFacts(
  world: ClientWorld,
): Promise<Asked<SshConfigFacts>> {
  // [LAW:one-source-of-truth] exception: this command is a client of the
  // daemon run from the user's own shell, so it finds the socket the way every
  // client does, from that shell's environment.
  const socket = socketPath(world.host);
  const outcome = await fetchStats(world);
  if (outcome.kind !== "ok") {
    return {
      kind: "failed",
      reason: `no daemon answered on ${socket}, and its link key is what the stanza names: ${describeFailure(outcome)}`,
    };
  }
  if (outcome.value.kind !== "ours") {
    return { kind: "failed", reason: outcome.value.skew };
  }
  const keyId = outcome.value.snapshot.linkKeyId;
  return keyId.kind === "ok"
    ? { kind: "ok", value: { keyId: keyId.value, socket } }
    : { kind: "failed", reason: `the daemon has no link key: ${keyId.reason}` };
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
// name the URL handler opens for a link signed by this machine's key). The
// forward's directory is made by `cc-candybar install` on the Mac, the one
// creator that checks who owns it. [LAW:single-enforcer]
export function sshConfigPlan(
  args: readonly string[],
  asked: Asked<SshConfigFacts>,
): CliPlan {
  const [alias, ...extra] = args;
  // [LAW:parse-dont-validate] The alias is one word of ssh's config naming one
  // host: no wildcard or negation (`*`, `?`, `!`), which would make a pattern.
  if (alias === undefined || extra.length > 0 || !/^[^\s#*?!]+$/.test(alias)) {
    return { stdout: "", stderr: USAGE, code: 2 };
  }
  if (asked.kind === "failed") {
    return { stdout: "", stderr: `ssh-config: ${asked.reason}\n`, code: 1 };
  }
  const facts = asked.value;
  if (!/^[^\s%]+$/.test(facts.socket)) {
    return {
      stdout: "",
      stderr: `ssh-config: the daemon's socket ${JSON.stringify(facts.socket)} holds a space or a %, which ssh's config cannot carry; set CC_CANDYBAR_SOCKET to a path without one\n`,
      code: 1,
    };
  }
  const stanza = [
    "# Run on the machine you sit at, not on this one:",
    `#   cc-candybar install   (makes ~/${REMOTE_SOCKET_DIR_UNDER_HOME} and the URL handler)`,
    "# and add this to its ~/.ssh/config. Clicks on this machine's bar then reach",
    "# it while an ssh connection to it is open.",
    `Host ${alias}`,
    "  StreamLocalBindUnlink yes",
    `  LocalForward %d/${REMOTE_SOCKET_DIR_UNDER_HOME}/${facts.keyId}${REMOTE_SOCKET_SUFFIX} ${facts.socket}`,
    "",
  ].join("\n");
  return { stdout: stanza, stderr: "", code: 0 };
}
