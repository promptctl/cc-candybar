import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { OWNER_CONTEXT, type Launcher } from "../proc/launcher.js";
import type { WatcherRegistry } from "./cache/watchers.js";
import { watchTargetsOf } from "./foundations/watch-targets.js";
import { parseSessionId, type SessionId } from "./foundations/session-id.js";
import type {
  SourceEdges,
  SourcePaneProcess,
  SourceProof,
} from "./tmux-source-authority.js";
import { PROCESS_START_ENV } from "./process-fingerprint.js";

interface Member {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly foreground: number;
  readonly tty: string;
  readonly start: string;
}

const MAX_TTY_PROCESSES = 128;
const MAX_RECORD_BYTES = 64 * 1024;
const unknown = (reason: string): SourceProof => ({ kind: "unknown", reason });

function rooted(
  pid: number,
  root: number,
  members: ReadonlyMap<number, Member>,
): boolean {
  const seen = new Set<number>();
  while (!seen.has(pid)) {
    if (pid === root) return true;
    seen.add(pid);
    const member = members.get(pid);
    if (!member) return false;
    pid = member.parent;
  }
  return false;
}

// [LAW:parse-dont-validate] ps -t reads one controlling terminal. Both the
// terminal and the ancestry back to tmux's exact pane root must agree.
export function foregroundMembers(
  pane: SourcePaneProcess,
  listing: string,
): Member[] {
  const lines = listing.trim().split("\n");
  if (lines.length > MAX_TTY_PROCESSES)
    throw new Error("too many processes on the source tty");
  const members = new Map<number, Member>();
  for (const line of lines) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("invalid source tty process metadata");
    const [, id, parent, group, foreground, tty, start] = match;
    members.set(Number(id), {
      pid: Number(id),
      parent: Number(parent),
      group: Number(group),
      foreground: Number(foreground),
      tty: `/dev/${tty}`,
      start: start!,
    });
  }
  const root = members.get(pane.pid);
  if (!root || root.tty !== pane.tty || root.foreground < 1)
    throw new Error("source pane root has no matching foreground tty");
  return [...members.values()].filter(
    (p) =>
      p.tty === pane.tty &&
      p.group === root.foreground &&
      p.foreground === root.foreground &&
      rooted(p.pid, pane.pid, members),
  );
}

interface Identity {
  readonly start: string;
  readonly domain: string;
}

// Claude on Darwin writes C-locale UTC ps lstart. On Linux it writes the
// kernel's start ticks and its PID namespace. Neither token is a timestamp
// to convert; compare the representations each implementation actually writes.
function identity(member: Member): Identity | null {
  if (process.platform === "darwin")
    return { domain: "darwin", start: member.start };
  if (process.platform !== "linux")
    throw new Error(
      `unsupported foreground process identity on ${process.platform}`,
    );
  try {
    const ns = readlinkSync(`/proc/${member.pid}/ns/pid`);
    if (ns !== readlinkSync("/proc/self/ns/pid")) return null;
    const stat = readFileSync(`/proc/${member.pid}/stat`, "utf8");
    // comm is parenthesized and can itself contain spaces and parentheses.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (
      Number(fields[1]) !== member.parent ||
      Number(fields[2]) !== member.group ||
      Number(fields[5]) !== member.foreground ||
      !/^\d+$/.test(fields[19] ?? "")
    )
      return null;
    return { domain: `linux::${ns}`, start: fields[19]! };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

interface RecordFact {
  readonly sid: SessionId;
  readonly pid: number;
  readonly start: string;
  readonly domain: string;
}

// No directory scan and no unbounded read. A missing PID file is ordinary for
// every foreground helper that is not Claude.
function record(file: string): RecordFact | null {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES)
      throw new Error(`invalid Claude record at ${file}`);
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size !== stat.size)
      throw new Error(`Claude record changed during read at ${file}`);
    const data = JSON.parse(buffer.toString("utf8", 0, size));
    if (data?.kind !== "interactive" || data.entrypoint !== "cli") return null;
    const sid = parseSessionId(data.sessionId);
    if (
      !sid.ok ||
      !Number.isSafeInteger(data.pid) ||
      typeof data.procStart !== "string" ||
      typeof data.pidDomain !== "string"
    )
      throw new Error(`invalid identity in Claude record at ${file}`);
    return {
      sid: sid.id,
      pid: data.pid,
      domain: data.pidDomain,
      start: data.procStart,
    };
  } finally {
    closeSync(fd);
  }
}

function revision(file: string): string {
  try {
    return JSON.stringify(record(file));
  } catch (error) {
    return String(error);
  }
}

export function createTmuxSourceEdges(
  launcher: Pick<Launcher, "launch">,
  watchers: Pick<WatcherRegistry, "acquire">,
): SourceEdges {
  return {
    async inspect(pane, claims, watch) {
      if (!/^\/dev\/(?:tty[a-zA-Z0-9]+|pts\/\d+)$/.test(pane.tty))
        return unknown("invalid source pane tty");
      const result = await launcher.launch({
        ...OWNER_CONTEXT,
        bin: "ps",
        args: [
          "-t",
          pane.tty.slice(5),
          "-o",
          "pid=,ppid=,pgid=,tpgid=,tty=,lstart=",
        ],
        category: "process-fingerprint",
        timeoutMs: 2000,
        envOverlay: PROCESS_START_ENV,
      });
      if (!result.ok)
        return unknown(`source tty lookup failed: ${result.reason}`);
      const members = foregroundMembers(pane, result.stdout);
      const table = new Map(members.map((p) => [p.pid, p]));
      const outside = claims.filter(
        (c) => c.parentPid !== undefined && !table.has(c.parentPid),
      );
      const candidates = new Map<string, Member>();
      // A known invoker narrows the record read to that process and its
      // foreground ancestors. Older clients require searching the whole group.
      for (const claim of claims) {
        if (claim.parentPid !== undefined && !table.has(claim.parentPid))
          continue;
        for (const member of members) {
          if (
            claim.parentPid !== undefined &&
            !rooted(claim.parentPid, member.pid, table)
          )
            continue;
          candidates.set(
            path.join(claim.configDir, "sessions", `${member.pid}.json`),
            member,
          );
          if (candidates.size > MAX_TTY_PROCESSES)
            return {
              ...unknown("too many possible foreground process records"),
              outside,
            };
        }
      }
      watch([...candidates.keys()]);
      const owners = new Map<number, { sid: SessionId; files: Set<string> }>();
      let unreadable: string | undefined;
      for (const [file, member] of candidates) {
        let fact: RecordFact | null;
        try {
          fact = record(file);
        } catch (error) {
          unreadable ??= String(error);
          continue;
        }
        if (!fact || fact.pid !== member.pid) continue;
        const live = identity(member);
        if (!live || live.start !== fact.start || live.domain !== fact.domain)
          continue;
        const prior = owners.get(member.pid);
        if (prior && prior.sid !== fact.sid)
          return unknown(
            "conflicting Claude records for the foreground process",
          );
        if (prior) prior.files.add(file);
        else owners.set(member.pid, { sid: fact.sid, files: new Set([file]) });
      }
      const outer = [...owners].filter(([pid]) =>
        [...owners.keys()].every((other) => rooted(other, pid, table)),
      );
      if (outer.length !== 1)
        return {
          ...unknown(
            owners.size
              ? "ambiguous foreground Claude processes"
              : (unreadable ??
                  "no matching live interactive Claude record in the source pane"),
          ),
          outside,
        };
      const [pid, owner] = outer[0]!;
      const matching = claims.some(
        (c) =>
          c.sid === owner.sid &&
          (c.parentPid === undefined || c.parentPid === pid) &&
          owner.files.has(path.join(c.configDir, "sessions", `${pid}.json`)),
      );
      return matching
        ? { kind: "confirmed", sid: owner.sid, outside }
        : {
            ...unknown(
              "foreground Claude record does not confirm a reported session and parent",
            ),
            outside,
          };
    },
    watch(file, changed) {
      const spec = watchTargetsOf({
        named: [file],
        whole: [path.dirname(file)],
      });
      let previous: string;
      const handle = watchers.acquire(spec.key, spec.targets, () => {
        // Session records also change on ordinary activity. Only their owner
        // fields changing can justify re-reading the tty process table.
        const next = revision(file);
        if (previous !== next) {
          previous = next;
          changed();
        }
      });
      previous = revision(file);
      return () => handle.release();
    },
  };
}
