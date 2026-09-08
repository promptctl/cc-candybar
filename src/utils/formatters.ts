const CLAUDE_MODEL_PATTERN =
  /^(?:(?:global|apac|au|eu|us|us-east-\d|us-west-\d|eu-west-\d|eu-central-\d)\.)?(?:anthropic\.|azure_ai\/|bedrock\/|vertex_ai\/)?claude-(?:(?<family>opus|sonnet|haiku)-(?<newMajor>\d+)(?:-(?<newMinor>\d))?|(?<oldMajor>\d+)(?:-(?<oldMinor>\d))?-(?<oldFamily>opus|sonnet|haiku))(?:[-@]\d{8})?(?:-v\d+:\d+)?(?:-latest)?$/i;

const FRIENDLY_MODEL_PATTERN =
  /^(?<family>opus|sonnet|haiku)\s+(?<major>\d+)(?:\.(?<minor>\d))?$/i;

export function formatModelName(rawName: string): string {
  if (!rawName) {
    return "Claude";
  }

  // [LAW:one-source-of-truth] model.id and display_name both reach "Family X.Y".
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
  // [LAW:one-type-per-behavior] Same parser on formatModelName's canonical output.
  const match = formatted.match(FRIENDLY_MODEL_PATTERN);
  if (!match?.groups) return formatted;
  const family = match.groups.family!;
  const major = match.groups.major!;
  const minor = match.groups.minor;
  const initial = family.charAt(0).toUpperCase();
  const version = minor ? `${major}.${minor}` : major;
  return `${initial}${version}`;
}

// [LAW:decomposition] Fish `prompt_pwd`, knowing nothing of home-collapse or project paths.
export function abbreviatePath(path: string): string {
  const segments = path.split("/");
  const lastIndex = segments.length - 1;
  return segments
    .map((seg, i) => {
      if (i === lastIndex) return seg;
      const abbreviated = seg.match(/^\.*./);
      return abbreviated ? abbreviated[0] : seg;
    })
    .join("/");
}

// [LAW:one-source-of-truth] Every grouped integer goes here, never an ad-hoc toLocaleString.
export function formatInteger(n: number): string {
  return n.toLocaleString();
}
