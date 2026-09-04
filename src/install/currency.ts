// Is the runtime `install` just staged the newest published release? pnpm
// resolves `@latest` through its dlx cache and its release-age gate
// (`minimumReleaseAge`), either of which can hand back an older release with
// no error — so `pnpm dlx @promptctl/cc-candybar@latest install` can stage a
// version several releases behind and report success. This module answers the
// currency question as data: a strict version parser at the border, the
// registry lookup as an `Outcome`, one total fold into a `Currency`, and one
// formatter that describes the report for `runInstall` to perform.

import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

// [LAW:types-are-the-program] A release version is exactly MAJOR.MINOR.PATCH.
// semantic-release on `main` mints nothing else, and the ordering the currency
// verdict needs is total only over that shape — so the parser refuses anything
// else loudly rather than admitting a prerelease it could not order.
export type Version = readonly [major: number, minor: number, patch: number];

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// [LAW:parse-dont-validate] The one crossing from text to `Version`. Both the
// baked stamp and the registry's dist-tag pass through here; downstream code
// takes `Version` and never re-checks the shape.
export function parseReleaseVersion(text: string): Version {
  const m = RELEASE_VERSION.exec(text);
  if (!m) {
    throw new Error(
      `"${text}" is not a release version (expected MAJOR.MINOR.PATCH)`,
    );
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
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

// The check rides at the end of an install; it may not hang one. A registry
// that answers slower than this is reported as unreachable, not waited on.
export const REGISTRY_TIMEOUT_MS = 5_000;

// [LAW:effects-at-boundaries] The one network effect in the install path. It
// takes `fetch` as a parameter so the pure core above and the tests never
// touch the wire; the caller hands in the global. Every way the lookup can
// fail to answer — refused, timed out, non-2xx, unparseable body, dist-tag not
// a release — collapses to `failed` with its reason preserved, and a registry
// that lists no `latest` tag at all is `absent`. [LAW:no-silent-failure] None
// of those is ever reported as "current".
export async function fetchLatestVersion(
  packageName: string,
  fetchImpl: typeof fetch,
): Promise<Outcome<Version>> {
  const url = `${REGISTRY_URL}/-/package/${packageName}/dist-tags`;
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
    return ok(parseReleaseVersion(tags.latest));
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// [LAW:types-are-the-program] The verdict. `unchecked` is its own arm rather
// than a `current` with a flag: an install that could not ask the registry has
// no currency, and no consumer may read it as having one.
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
      readonly installed: Version;
      readonly reason: string;
    };

// [LAW:dataflow-not-control-flow] One total fold: the lookup outcome and the
// version ordering both flow in as values, and every combination lands in
// exactly one arm.
export function assessCurrency(
  installed: Version,
  latest: Outcome<Version>,
): Currency {
  switch (latest.kind) {
    case "failed":
      return { kind: "unchecked", installed, reason: latest.reason };
    case "absent":
      return {
        kind: "unchecked",
        installed,
        reason: "the registry lists no `latest` dist-tag",
      };
    case "ok": {
      const order = compareVersions(installed, latest.value);
      if (order < 0) {
        return { kind: "stale", installed, latest: latest.value };
      }
      if (order > 0) {
        return { kind: "ahead", installed, latest: latest.value };
      }
      return { kind: "current", installed };
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
  const installed = formatVersion(currency.installed);
  switch (currency.kind) {
    case "current":
      return {
        stream: "stdout",
        text: `✓ cc-candybar ${installed} is the latest release.\n`,
      };
    case "ahead":
      return {
        stream: "stdout",
        text:
          `cc-candybar ${installed} is newer than the registry's latest release ` +
          `(${formatVersion(currency.latest)}): an unpublished build.\n`,
      };
    case "stale": {
      const latest = formatVersion(currency.latest);
      return {
        stream: "stderr",
        text:
          `⚠ cc-candybar ${installed} was staged, but the latest release is ${latest}.\n` +
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
          `⚠ Could not check for a cc-candybar release newer than ${installed} ` +
          `(${currency.reason}); the registry check was skipped.\n`,
      };
  }
}
