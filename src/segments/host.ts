import os from "node:os";

import { ABSENT, failed, ok, type Outcome } from "../utils/outcome.js";
import type { Holds } from "../utils/holds.js";
import { KeyedSource } from "../utils/keyed-source.js";
import { quietLogger, type DaemonLogger } from "../utils/logger.js";
import { RefreshLedger } from "../utils/refresh-ledger.js";
import type { Lane } from "../utils/reading.js";

// How often the host's name and user are asked again while a view reads
// them: the name follows the network (DHCP, a VPN), so a daemon that lives
// for days sees it move, and a user lookup that failed (a directory service
// briefly unreachable) is retried.
export const HOST_PERIOD_MS = 60_000;
const HOST_EVERY = { okMs: HOST_PERIOD_MS, failedMs: HOST_PERIOD_MS };

/**
 * Project `os.hostname()` to its short form: everything before the first dot, or
 * the whole name when
 * there is no dot. `os.hostname()` yields an FQDN on some hosts (macOS's
 * `mymachine.local`, a DNS-configured server's `web1.prod.example.com`) and a
 * bare name on others; this makes the rendered cell identify the machine the
 * same way on both, which is zsh's `%m` and the projection git-taculous shows.
 *
 * [LAW:effects-at-boundaries] Pure and total — the syscall stays in the source
 * that reads it.
 */
export function shortHostname(hostname: string): string {
  const dot = hostname.indexOf(".");
  return dot < 0 ? hostname : hostname.slice(0, dot);
}

// [LAW:effects-at-boundaries] One syscall, the whole of its source's read.
// [LAW:no-silent-failure] A throwing syscall (a uid with no passwd entry is
// the realistic case, in a stripped container) is that field's failed read,
// logged once by its refresh — never a fabricated name, and never an
// exception: the whole bar must not blank over a cosmetic cell. "" is no
// usable identity, so it is absent and the DSL default applies.
function syscall(field: string, read: () => string): Promise<Outcome<string>> {
  try {
    const value = read();
    return Promise.resolve(value === "" ? ABSENT : ok(value));
  } catch (e) {
    return Promise.resolve(failed(`host.${field}: ${String(e)}`));
  }
}

// [LAW:one-type-per-behavior] The machine's identity is two daemon-scoped
// sources, each one key and one period: its short host name and the user the
// daemon runs as. Each is read first by the view that declares it, so a
// process that renders nothing reads neither, and each fails alone. The
// session's own `ssh` hint is laid over them per payload.
export class HostService {
  private readonly name: KeyedSource<null, string>;
  private readonly user: KeyedSource<null, string>;

  constructor(
    opts: {
      readonly logger?: DaemonLogger;
      readonly ledger?: RefreshLedger;
    } = {},
  ) {
    const logger = opts.logger ?? quietLogger;
    const ledger = opts.ledger ?? new RefreshLedger(logger);
    const one = {
      scope: "daemon",
      keyOf: () => "",
      fields: () => "-",
      every: HOST_EVERY,
      maxEntries: 1,
      logger,
      ledger,
    } as const;
    this.name = new KeyedSource({
      ...one,
      name: "host.name",
      read: () => syscall("name", () => shortHostname(os.hostname())),
    });
    this.user = new KeyedSource({
      ...one,
      name: "host.user",
      read: () => syscall("user", () => os.userInfo().username),
    });
  }

  declareName(holds: Holds): Lane<string> {
    return this.name.declare(holds, null);
  }

  declareUser(holds: Holds): Lane<string> {
    return this.user.declare(holds, null);
  }

  // How many of its two sources a view holds now.
  held(): number {
    return this.name.stats().held + this.user.stats().held;
  }

  close(): void {
    this.name.close();
    this.user.close();
  }
}
