// [LAW:types-are-the-program] A layer's place in its session's chain, lowest
// precedence first: the user's own file, the project's checked-in file, and
// the local file beside it that holds one person's settings for the project.
export const LAYER_ROLES = ["user", "project", "local"] as const;
export type LayerRole = (typeof LAYER_ROLES)[number];
export const DEFAULT_WRITE_LAYER = "user" satisfies LayerRole;

// Where a config-writing action writes: one role, or `ask`, which offers the
// session's writable roles and takes the one the click picks.
export type LayerChoice = LayerRole | "ask";

// Each role, and whether `roles` holds it: a total record a template reads.
export function layerFlags(
  roles: readonly LayerRole[],
): Readonly<Record<LayerRole, boolean>> {
  const [user, project, local] = LAYER_ROLES;
  return {
    [user]: roles.includes(user),
    [project]: roles.includes(project),
    [local]: roles.includes(local),
  };
}

// [LAW:parse-dont-validate] A role off a wire or out of a file, or null.
export function layerRoleOf(raw: unknown): LayerRole | null {
  return LAYER_ROLES.find((role) => role === raw) ?? null;
}
