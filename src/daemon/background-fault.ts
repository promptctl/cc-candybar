// A throw in work no request waits on: the daemon's background work. Every
// failure this work expects is already a value its readers see, so a throw is
// a bug in the daemon, and it is told to every bar.

// [LAW:types-are-the-program] The background work a fault names: a closed
// set, because each is a unit the daemon runs on its own.
export type BackgroundWork =
  | "git refresh"
  | "PR lookup"
  | "config discovery"
  | "watch delivery";

export interface BackgroundFault {
  readonly work: BackgroundWork;
  // What the work was for: the repo's root, the origin's key, the watch.
  readonly subject: string;
  readonly thrown: unknown;
}

// [LAW:single-enforcer] Where an owner hands a throw. The daemon's is the one
// that logs it and holds it for the bar; an owner takes it as a required
// dependency, so an unwired owner does not compile.
export type ReportFault = (fault: BackgroundFault) => void;
