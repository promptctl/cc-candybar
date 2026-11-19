import type { Timekeeper } from "../time.js";
import {
  checkoutLocation,
  checkoutOf,
  worktreeLink,
  type CheckoutFiles,
} from "../utils/git-root.js";
import { oncePerPath } from "../utils/once-per-path.js";
import type { Outcome } from "../utils/outcome.js";

export const CHECKOUT_FRESH_MS = 1_000;
const MAX_PATHS_PER_PROBE = 512;
const MAX_RETAINED_CHARACTERS = 8 * 1024;

function retainMetadata(read: Outcome<string>): boolean {
  switch (read.kind) {
    case "ok":
      return read.value.length <= MAX_RETAINED_CHARACTERS;
    case "failed":
      return read.reason.length <= MAX_RETAINED_CHARACTERS;
    case "absent":
      return true;
  }
}

function observed<T>(
  read: (file: string) => T,
  clock: Pick<Timekeeper, "monotonic">,
  retain: (value: T) => boolean = () => true,
) {
  const paths = new Map<string, { value: T; expires: number }>();
  const refresh = (file: string): T => {
    const value = read(file);
    paths.delete(file);
    // [LAW:carrying-cost] A path supplied by a session may hold much more
    // than Git's normal metadata. Keep its result local to this observation.
    if (file.length > MAX_RETAINED_CHARACTERS || !retain(value)) return value;
    paths.set(file, { value, expires: clock.monotonic() + CHECKOUT_FRESH_MS });
    if (paths.size > MAX_PATHS_PER_PROBE) {
      const oldest = paths.keys().next();
      if (!oldest.done) paths.delete(oldest.value);
    }
    return value;
  };
  return {
    // [LAW:no-ambient-temporal-coupling] A redraw never extends freshness.
    held: (file: string): T => {
      const seen = paths.get(file);
      return seen !== undefined && clock.monotonic() < seen.expires
        ? seen.value
        : refresh(file);
    },
    fresh: () => oncePerPath(refresh),
  };
}

// [LAW:no-shared-mutable-globals] One owner per host, independent of renderer
// names and session request history. The display canonicalizes directories
// before asking for Git metadata, so aliases share physical probes.
export function checkoutObservations(
  files: CheckoutFiles,
  clock: Pick<Timekeeper, "monotonic">,
) {
  const stat = observed(files.stat, clock);
  const lstat = observed(files.lstat, clock);
  const realpath = observed(files.realpath, clock, retainMetadata);
  const text = observed(files.text, clock, retainMetadata);
  const held = {
    stat: stat.held,
    lstat: lstat.held,
    realpath: realpath.held,
    text: text.held,
  };
  return {
    location: (dir: string) => checkoutLocation(dir, held),
    // [LAW:parse-dont-validate] Repository admission gets fresh proof for its
    // own batch. Its physical observations can warm display, never the reverse.
    discovery: () => {
      const fresh = {
        stat: stat.fresh(),
        lstat: lstat.fresh(),
        realpath: realpath.fresh(),
        text: text.fresh(),
      };
      return {
        checkout: (dir: string) => checkoutOf(dir, fresh),
        worktree: (dir: string) => worktreeLink(dir, fresh),
      };
    },
  };
}
