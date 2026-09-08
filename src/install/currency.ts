// pnpm's dlx cache and release-age gate can both resolve `@latest` to an older release with no error.

import { ABSENT, failed, type Outcome } from "../utils/outcome";

// [LAW:types-are-the-program] Ordering is total only over MAJOR.MINOR.PATCH.
export type Version = readonly [major: number, minor: number, patch: number];

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type Parsed<T> = Exclude<Outcome<T>, { kind: "absent" }>;

// [LAW:parse-dont-validate] The one crossing from text to `Version`; failure is typed, not thrown.
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

function compareVersions(
  [aMajor, aMinor, aPatch]: Version,
  [bMajor, bMinor, bPatch]: Version,
): number {
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

export const REGISTRY_URL = "https://registry.npmjs.org";

export const PACKAGE_NAME = "@promptctl/cc-candybar";

// The check may not hang an install: a slower registry is unreachable, not waited on.
export const REGISTRY_TIMEOUT_MS = 5_000;

// [LAW:effects-at-boundaries] The one network effect in the install path.
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

// [LAW:types-are-the-program] `unchecked` is its own arm, never a `current` with a flag.
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

// [LAW:dataflow-not-control-flow] One total fold; every combination lands in one arm.
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

export interface CurrencyReport {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

// [LAW:no-silent-failure] The unchecked arm never implies the install is current.
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
