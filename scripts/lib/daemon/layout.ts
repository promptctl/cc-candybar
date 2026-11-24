import path from "node:path";

import { stateDir } from "../../../src/daemon/paths";
import { hostOf } from "../host";

// [LAW:one-source-of-truth] An isolated daemon keeps its socket in its own
// state directory, so the socket a caller names the daemon by also names the
// state home its log is under. Both directions of that layout live here.
export const socketIn = (stateHome: string): string =>
  path.join(stateDir(hostOf({ XDG_STATE_HOME: stateHome })), "socket");

export const stateHomeOf = (socket: string): string =>
  path.dirname(path.dirname(socket));
