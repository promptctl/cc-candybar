import { randomUUID } from "node:crypto";

// [LAW:one-type-per-behavior] The one spelling of where this runtime's own
// writes stage their bytes before the rename or link that publishes them (a
// shell script or the Rust client names its staging in its own language). Two
// processes write one file when they share a state directory (a daemon and a
// CLI): under one shared name, one's rename publishes the other's half-written
// bytes and the other's rename then finds nothing. So every call names a
// staging of its own: the random part keeps any two writes apart (two in
// flight in one process, or two processes that pid namespaces give one pid),
// and the pid says whose a leftover is.
export function stagedPath(file: string): string {
  return `${file}.${process.pid}.${randomUUID()}.tmp`;
}
