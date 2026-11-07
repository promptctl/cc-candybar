import type { RepoGate } from "../../src/config/loader/repo-gate";

// What a session reaching no repository's config contributes, or whose
// repositories are approved and ship no plugins.
export const NO_REPOS: RepoGate = {
  plugins: null,
  approved: [],
  awaiting: [],
  declined: [],
  unproven: [],
  unread: null,
};
