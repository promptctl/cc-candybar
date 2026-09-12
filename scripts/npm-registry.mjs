// One question to the npm registry, asked one way by everyone who asks it:
// "does the registry serve <pkg>@<version> yet?"
//
// scripts/release.mjs asks it twice for different reasons — to skip a platform
// package it already published (so a rerun after a partial failure is safe), and
// to know when those publishes have become VISIBLE, which is what the lockfile
// regen needs to be true before it can resolve them. Same fact, one spelling
// [LAW:one-source-of-truth].
//
// Lives beside the release script rather than under src/: this is release-time
// machinery and has no business in the shipped bundle.

import { execFileSync } from "node:child_process";

// [LAW:parse-dont-validate] The answer is a three-state value, not a boolean.
// `npm view` exits 1 for BOTH "that version does not exist" (E404 — a real
// answer about the registry's contents) and "I could not reach the registry" (a
// failure to ask at all), and collapsing them destroys the distinction exactly
// where a caller needs it: a wait that ends with everything `absent` is npm
// propagation, a wait that ends with something `unchecked` is an outage or a
// bad token, and the two send a human to different places
// [LAW:no-silent-failure].
//
// `serves` carries no payload beyond itself: it means the registry answered with
// this exact version, which is the whole fact.
// [LAW:single-enforcer] `--fetch-retries=0` because the RETRY POLICY belongs to
// the caller's wait loop and nowhere else. npm's default is two retries with a
// 10s–60s backoff, nested invisibly inside each call, which turned one probe of
// an unreachable registry from 0.33s into minutes (measured) and made the wait's
// own budget a fiction — the outer loop cannot bound what an inner clock spends.
// One attempt per ask; the loop decides whether to ask again.
export function registryState(pkgName, version) {
  try {
    const out = execFileSync(
      "npm",
      ["view", `${pkgName}@${version}`, "version", "--fetch-retries=0"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    // A successful `npm view` of a version range could answer with a DIFFERENT
    // version; only this one counts as serving it.
    return out === version
      ? { kind: "serves" }
      : { kind: "absent", reason: `registry answered ${out || "(nothing)"}` };
  } catch (e) {
    const said = `${e.stderr ?? ""}${e.stdout ?? ""}`;
    if (said.includes("E404")) {
      return { kind: "absent", reason: "404 — no such version" };
    }
    return { kind: "unchecked", reason: firstLine(said) || String(e.message) };
  }
}

function firstLine(s) {
  return String(s)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

// [LAW:no-ambient-temporal-coupling] Wait for the FACT, never toward it. The
// caller's precondition is "the registry serves every one of these versions", so
// that condition — four cheap metadata reads — is what this polls and returns
// on. Waiting on the fact is what lets the budget be generous: the common path
// returns the moment it holds, so ten minutes of headroom costs nothing when
// propagation takes five seconds. A loop that instead re-ran the expensive
// operation downstream (a full `pnpm install --lockfile-only` resolve) and read
// its leftovers to infer the same fact could not afford patience, which is how a
// three-minute ceiling ended up standing between a published package and a
// finished release (brandon-release-j08).
//
// [LAW:effects-at-boundaries] Returns the verdict; it never exits the process.
// The budget and the poll interval are parameters, not constants, so the
// timed-out arm is reachable in a second by a caller who wants to see it — a
// failure path nobody can reach cheaply is a failure path nobody has read.
export function awaitRegistryVisibility(
  pkgNames,
  version,
  { budgetMs, pollMs, log = () => {} },
) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const pending = pkgNames
      .map((name) => ({ name, state: registryState(name, version) }))
      .filter(({ state }) => state.kind !== "serves");
    if (pending.length === 0) return { kind: "visible" };
    if (Date.now() >= deadline) return { kind: "timedOut", pending };
    log(
      `waiting for the registry to serve ${version}: ${pending
        .map(({ name, state }) => `${name} (${state.reason})`)
        .join(", ")}`,
    );
    sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

// A synchronous sleep with no subprocess: this module runs inside a
// semantic-release step that is itself synchronous top to bottom.
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
