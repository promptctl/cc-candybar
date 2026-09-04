// Is the runtime `install` just staged the newest published release? pnpm
// resolves `@latest` through its dlx cache and its release-age gate
// (`minimumReleaseAge`), either of which can hand back an older release with
// no error — so `pnpm dlx @promptctl/cc-candybar@latest install` can stage a
// version several releases behind and report success. This module answers the
// currency question as data: a strict version parser at the border, the
// registry lookup as an `Outcome`, one total fold into a `Currency`, and one
// formatter that describes the report for `runInstall` to perform.

import { ABSENT, failed, type Outcome } from "../utils/outcome";

// [LAW:types-are-the-program] A release version is exactly MAJOR.MINOR.PATCH.
// semantic-release on `main` mints nothing else, and the ordering the currency
// verdict needs is total only over that shape — so the parser refuses anything
// else rather than admitting a prerelease it could not order.
export type Version = readonly [major: number, minor: number, patch: number];

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// A parse either produces a value or fails with a reason; "absent" is not a
// shape text can have.
type Parsed<T> = Exclude<Outcome<T>, { kind: "absent" }>;

// [LAW:parse-dont-validate] The one crossing from text to `Version`. Both the
// baked stamp and the registry's dist-tag pass through here; downstream code
// takes `Version` and never re-checks the shape. The failure is typed, not
// thrown: on either side it flows into the `unchecked` verdict, so the
// advisory check can never take the install down with it.
export function parseReleaseVersion(text: string): Parsed<Version> {
  const m = RELEASE_VERSION.exec(text);
  return m
    ? { kind: "ok", value: [Number(m[1]), Number(m[2]), Number(m[3])] }
    : {
        kind: "failed",
        reason: `"${text}" is not a release version (expected MAJOR.MINOR.PATCH)`,
      };
}

export function formatVersion(v: Version): string {
  return v.join(".");
}

// Lexicographic over the triple: the first differing component decides.
function compareVersions(
  [aMajor, aMinor, aPatch]: Version,
  [bMajor, bMinor, bPatch]: Version,
): number {
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

export const REGISTRY_URL = "https://registry.npmjs.org";

// [LAW:one-source-of-truth] The published package's name, here in the leaf
// both the install banner and the daemon's release watch read it from.
export const PACKAGE_NAME = "@promptctl/cc-candybar";

// The check rides at the end of an install; it may not hang one. A registry
// that answers slower than this is reported as unreachable, not waited on.
export const REGISTRY_TIMEOUT_MS = 5_000;

// [LAW:effects-at-boundaries] The one network effect in the install path. It
// takes `fetch` and the registry as parameters so the pure core above and the
// tests never touch the wire; the caller hands in the global and REGISTRY_URL
// (or the daemon's `CC_CANDYBAR_REGISTRY_URL` override). Every way the lookup can
// fail to answer — refused, timed out, non-2xx, unparseable body, dist-tag not
// a release — collapses to `failed` with its reason preserved, and a registry
// that lists no `latest` tag at all is `absent`. [LAW:no-silent-failure] None
// of those is ever reported as "current".
export async function fetchLatestVersion(
  packageName: string,
  fetchImpl: typeof fetch,
  registryUrl: string,
): Promise<Outcome<Version>> {
  const url = `${registryUrl}/-/package/${encodeURIComponent(packageName)}/dist-tags`;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) {
      return failed(`registry responded ${res.status} for ${url}`);
    }
    const tags = (await res.json()) as { latest?: unknown };
    if (typeof tags.latest !== "string") {
      return ABSENT;
    }
    return parseReleaseVersion(tags.latest);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// [LAW:types-are-the-program] The verdict. `unchecked` is its own arm rather
// than a `current` with a flag: an install that could not compare has no
// currency, and no consumer may read it as having one. It carries the stamp
// as text because the stamp itself may be what failed to parse.
export type Currency =
  | { readonly kind: "current"; readonly installed: Version }
  | {
      readonly kind: "stale";
      readonly installed: Version;
      readonly latest: Version;
    }
  | {
      readonly kind: "ahead";
      readonly installed: Version;
      readonly latest: Version;
    }
  | {
      readonly kind: "unchecked";
      readonly installed: string;
      readonly reason: string;
    };

// [LAW:dataflow-not-control-flow] One total fold: the stamp, the lookup
// outcome, and the version ordering all flow in as values, and every
// combination lands in exactly one arm.
export function assessCurrency(
  stamp: string,
  latest: Outcome<Version>,
): Currency {
  const installed = parseReleaseVersion(stamp);
  if (installed.kind === "failed") {
    return { kind: "unchecked", installed: stamp, reason: installed.reason };
  }
  switch (latest.kind) {
    case "failed":
      return { kind: "unchecked", installed: stamp, reason: latest.reason };
    case "absent":
      return {
        kind: "unchecked",
        installed: stamp,
        reason: "the registry lists no `latest` dist-tag",
      };
    case "ok": {
      const order = compareVersions(installed.value, latest.value);
      if (order < 0) {
        return {
          kind: "stale",
          installed: installed.value,
          latest: latest.value,
        };
      }
      if (order > 0) {
        return {
          kind: "ahead",
          installed: installed.value,
          latest: latest.value,
        };
      }
      return { kind: "current", installed: installed.value };
    }
  }
}

// A description of the report, not the report itself: `runInstall` owns the
// write. Warnings go to stderr, confirmations to stdout — the CLI's stream
// contract, so a scripted install can separate the two.
export interface CurrencyReport {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

// [LAW:no-silent-failure] The stale arm names the cause and the exact command
// that gets the current release now; the unchecked arm says the check was
// skipped and why, and never implies the install is current.
export function currencyReport(
  packageName: string,
  currency: Currency,
): CurrencyReport {
  switch (currency.kind) {
    case "current":
      return {
        stream: "stdout",
        text: `✓ cc-candybar ${formatVersion(currency.installed)} is the latest release.\n`,
      };
    case "ahead":
      return {
        stream: "stdout",
        text:
          `cc-candybar ${formatVersion(currency.installed)} is newer than the registry's latest release ` +
          `(${formatVersion(currency.latest)}): an unpublished build.\n`,
      };
    case "stale": {
      const latest = formatVersion(currency.latest);
      return {
        stream: "stderr",
        text:
          `⚠ cc-candybar ${formatVersion(currency.installed)} was staged, but the latest release is ${latest}.\n` +
          `  pnpm's release-age gate (minimumReleaseAge) and its dlx cache can both\n` +
          `  resolve \`@latest\` to an older release without saying so.\n` +
          `  To install ${latest} now, name it explicitly:\n` +
          `    pnpm dlx ${packageName}@${latest} install\n`,
      };
    }
    case "unchecked":
      return {
        stream: "stderr",
        text:
          `⚠ Could not check for a cc-candybar release newer than ${currency.installed} ` +
          `(${currency.reason}); the registry check was skipped.\n`,
      };
  }
}
