// A pre-enrollment split recorded its argv but tmux discarded the split-local
// environment once it started. Match every argv word before examining a peer.
// tmux's pane_start_command renders argv with quotes and VIS escapes. Read
// that representation as data, without evaluating it in a shell.
import { OWNER_CONTEXT, type Launcher } from "../proc/launcher.js";

export function matchesLegacyCommand(
  text: string,
  expected: readonly string[],
): boolean {
  let offset = 0;
  for (const [index, wanted] of expected.entries()) {
    if (index && text[offset++] !== " ") return false;
    const quote =
      text[offset] === "'" || text[offset] === '"' ? text[offset++] : undefined;
    let actual = "";
    while (offset < text.length) {
      const ch = text[offset]!;
      if (quote ? ch === quote : ch === " ") break;
      offset++;
      if (ch !== "\\") {
        actual += ch;
        continue;
      }
      const escaped = text[offset++];
      if (escaped === undefined) return false;
      if (escaped === "t") actual += "\t";
      else if (escaped === "n") actual += "\n";
      else if (escaped === "r") actual += "\r";
      else if (/[0-7]/.test(escaped)) {
        const octal = escaped + text.slice(offset, offset + 2);
        if (!/^[0-7]{3}$/.test(octal)) return false;
        actual += String.fromCharCode(parseInt(octal, 8));
        offset += 2;
      } else actual += escaped;
    }
    if (quote && text[offset++] !== quote) return false;
    if (actual !== wanted) return false;
  }
  return offset === text.length;
}

// Darwin reports a client's connected UNIX peer as a kernel socket address.
// A grant requires the other end to belong to this daemon and its named
// socket. Other systems or an idle/disconnected follower have no such grant.
export async function legacyPeerOn(
  launcher: Launcher,
  followerPid: number,
  socket: string,
): Promise<boolean> {
  if (process.platform !== "darwin" || followerPid === process.pid)
    return false;
  const got = await launcher.launch({
    ...OWNER_CONTEXT,
    bin: "/usr/sbin/lsof",
    args: ["-anP", "-p", `${process.pid},${followerPid}`, "-U", "-F0pfdn"],
    timeoutMs: 2000,
    category: "lane.tmux",
  });
  if (!got.ok) return false;
  const theirs = new Set<string>(),
    ours = new Set<string>();
  let pid = "",
    device = "",
    name = "";
  const flush = () => {
    if (pid === String(followerPid) && /^->0x[\da-f]+$/i.test(name))
      theirs.add(name.slice(2));
    if (
      pid === String(process.pid) &&
      name === socket &&
      /^0x[\da-f]+$/i.test(device)
    )
      ours.add(device);
    device = "";
    name = "";
  };
  for (const field of got.stdout.split("\0")) {
    const record = field.replace(/^\n/, "");
    switch (record[0]) {
      case "p":
        flush();
        pid = record.slice(1);
        break;
      case "f":
        flush();
        break;
      case "d":
        device = record.slice(1);
        break;
      case "n":
        name = record.slice(1);
        break;
    }
  }
  flush();
  return [...theirs].some((peer) => ours.has(peer));
}
