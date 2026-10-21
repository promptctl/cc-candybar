// The process table as `ps -A -o pid=,ppid=,<column>=` prints it, and the
// walk from a process up through the processes it descends from.
//
// [LAW:one-source-of-truth] The one reader of that table: the doctor asks
// whether a terminal descends from a remote login (src/doctor/edge.ts), and a
// lane's restart whether Claude Code runs under cc-attach
// (src/daemon/lane-edge.ts).

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  // The last column, as `ps` printed it: `comm` or the whole `args`.
  readonly command: string;
}

// [LAW:effects-at-boundaries] Pure over the table's text.
export function processTable(ps: string): ReadonlyMap<number, Proc> {
  const procs = new Map<number, Proc>();
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    procs.set(pid, { pid, ppid: Number(m[2]), command: m[3]!.trim() });
  }
  return procs;
}

// The process `pid` and each process it descends from, nearest first: the
// walk ends at a parent the table does not hold, or at one already walked
// (pid 0 is its own parent on some systems).
export function* lineage(
  procs: ReadonlyMap<number, Proc>,
  pid: number,
): Generator<Proc> {
  const seen = new Set<number>();
  for (let p = procs.get(pid); p !== undefined && !seen.has(p.pid); ) {
    seen.add(p.pid);
    yield p;
    p = procs.get(p.ppid);
  }
}
