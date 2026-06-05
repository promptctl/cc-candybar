const CLAUDE_MODEL_PATTERN =
  /^(?:(?:global|apac|au|eu|us|us-east-\d|us-west-\d|eu-west-\d|eu-central-\d)\.)?(?:anthropic\.|azure_ai\/|bedrock\/|vertex_ai\/)?claude-(?:(?<family>opus|sonnet|haiku)-(?<newMajor>\d+)(?:-(?<newMinor>\d))?|(?<oldMajor>\d+)(?:-(?<oldMinor>\d))?-(?<oldFamily>opus|sonnet|haiku))(?:[-@]\d{8})?(?:-v\d+:\d+)?(?:-latest)?$/i;

const FRIENDLY_MODEL_PATTERN =
  /^(?<family>opus|sonnet|haiku)\s+(?<major>\d+)(?:\.(?<minor>\d))?$/i;

export function formatModelName(rawName: string): string {
  if (!rawName) {
    return "Claude";
  }

  // [LAW:one-source-of-truth] strip variant decorations (e.g. " (1M context)",
  // "[1m]") so all callers see canonical "Family X.Y" output regardless of
  // whether the input came from model.id or model.display_name.
  const stripped = rawName
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim();

  const match = stripped.match(CLAUDE_MODEL_PATTERN);
  if (match?.groups) {
    const { family, newMajor, newMinor, oldMajor, oldMinor, oldFamily } =
      match.groups;

    const modelFamily = family || oldFamily;
    const major = newMajor || oldMajor;
    const minor = newMinor || oldMinor;

    if (modelFamily && major) {
      const capitalizedFamily =
        modelFamily.charAt(0).toUpperCase() +
        modelFamily.slice(1).toLowerCase();
      const version = minor ? `${major}.${minor}` : major;
      return `${capitalizedFamily} ${version}`;
    }
  }

  const friendly = stripped.match(FRIENDLY_MODEL_PATTERN);
  if (friendly?.groups) {
    const family = friendly.groups.family!;
    const major = friendly.groups.major!;
    const minor = friendly.groups.minor;
    const capitalizedFamily =
      family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
    const version = minor ? `${major}.${minor}` : major;
    return `${capitalizedFamily} ${version}`;
  }

  return stripped || rawName;
}

export function shortenModelName(formatted: string): string {
  // [LAW:one-type-per-behavior] same parser, different rendering — operates on
  // the canonical output of formatModelName so callers don't reparse raw IDs.
  const match = formatted.match(FRIENDLY_MODEL_PATTERN);
  if (!match?.groups) return formatted;
  const family = match.groups.family!;
  const major = match.groups.major!;
  const minor = match.groups.minor;
  const initial = family.charAt(0).toUpperCase();
  const version = minor ? `${major}.${minor}` : major;
  return `${initial}${version}`;
}

// [LAW:one-source-of-truth] Locale-grouped integer rendering. Callers that
// want "50,000" instead of "50000" go through this rather than calling
// toLocaleString() ad-hoc — the legacy context segment used the latter
// pattern inline, and the DSL formatter (template-engine/funcs.ts)
// delegates here so the two producers agree by construction.
//
// No locale argument: the default-locale behaviour is exactly what the
// legacy renderer did (`n.toLocaleString()`), so byte-parity holds with
// whatever locale the host process picks at startup.
export function formatInteger(n: number): string {
  return n.toLocaleString();
}
