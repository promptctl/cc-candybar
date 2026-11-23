// [LAW:one-source-of-truth] What a placement is, for the session state filed
// under it: the preset whose tree holds it, its id, and the segment it
// places. Each part alone falls short. An id is unique only within one
// preset's tree, and an id kept by a hand edit can come to name another
// segment, whose menus and settings share names with the old one's. So state
// keyed by less than all three is read by a placement it was never written
// for.
//
// [LAW:types-are-the-program] Every part is spelled `escapedIdent`, which emits
// no `.` and no `_`, behind a letter that names its part. A state key is read
// in templates as a field path, whose names cannot lead with a digit, and a
// preset, id or segment may. The letters also make the scope exactly three
// dot-separated parts that parse back to the identity, and no two identities
// meet in one spelling.

import { escapedIdent, unescapedIdent } from "./ident.js";

export interface PlacementIdentity {
  readonly preset: string;
  readonly id: string;
  readonly segment: string;
}

export function placementScope(identity: PlacementIdentity): string {
  return `p${escapedIdent(identity.preset)}.d${escapedIdent(identity.id)}.s${escapedIdent(identity.segment)}`;
}

// The identity a scope spells, or undefined for a spelling `placementScope`
// never makes.
export function placementOfScope(scope: string): PlacementIdentity | undefined {
  const [preset, id, segment, ...more] = scope.split(".");
  if (
    preset === undefined ||
    id === undefined ||
    segment === undefined ||
    more.length > 0 ||
    !preset.startsWith("p") ||
    !id.startsWith("d") ||
    !segment.startsWith("s")
  )
    return undefined;
  const parts = [preset, id, segment].map((part) =>
    unescapedIdent(part.slice(1)),
  );
  return parts.includes(undefined)
    ? undefined
    : {
        preset: parts[0]!,
        id: parts[1]!,
        segment: parts[2]!,
      };
}
