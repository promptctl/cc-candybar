// [LAW:one-source-of-truth] THE vocabulary a segment declaration's `group` is
// drawn from, and the one place its order and display labels live. Edit mode's
// add menu is a library of the declared segments; what it groups them BY is
// authored data on each declaration (`SegmentDecl.group`), never a list of
// segment names in the renderer, so a segment added by any config lands in its
// group with no wiring (brandon-menu-ia-q30.kpl).
//
// [LAW:types-are-the-program] A closed enum: a group no one declared a label
// for cannot be spelled, and the loader refuses it naming the legal ones.
// `other` is deliberately not a member: it is where a segment that declares no
// group stands, so it is the ABSENCE of a declaration, not a choice an author
// makes (the `bg?:` precedent).
export const SEGMENT_GROUPS = [
  "location",
  "git",
  "model-context",
  "cost-limits",
  "activity",
  "session-tools",
] as const;

export type SegmentGroup = (typeof SEGMENT_GROUPS)[number];

// What a segment that declares no group stands under.
export const OTHER_GROUP = "other";
export type LibraryGroup = SegmentGroup | typeof OTHER_GROUP;

// The library's pages, in order: every declared group, then `other`.
export const LIBRARY_GROUPS: readonly LibraryGroup[] = [
  ...SEGMENT_GROUPS,
  OTHER_GROUP,
];

export const GROUP_LABELS: Readonly<Record<LibraryGroup, string>> = {
  location: "location",
  git: "git",
  "model-context": "model & context",
  "cost-limits": "cost & limits",
  activity: "activity",
  "session-tools": "session tools",
  other: "other",
};
