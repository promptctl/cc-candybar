import {
  placementId,
  walkNodes,
  type DslConfig,
  type SegmentNode,
} from "../config/dsl-types";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
} from "../config/loader/edit-mode";
import { presetNames, presetRoot } from "../config/presets";
import { insertGap } from "../config/edit-chrome";
import { menuPageKey } from "../config/menu-keys";

// Every placement a change ended: a (preset, id) the config held before and no
// longer holds after. Measured over every preset, since a row can be shared:
// an edit made in one preset's layout can end a placement another renders.
// [LAW:dataflow-not-control-flow] No branch on what changed: an insertion ends
// nothing, and the comparison says so.
function endedPlacements(
  before: DslConfig,
  after: DslConfig,
): ReadonlyArray<{
  readonly preset: string;
  readonly member: string;
  readonly node: SegmentNode;
}> {
  const placed = (config: DslConfig, preset: string) =>
    [...walkNodes(presetRoot(config, preset).node)].filter(
      (n): n is SegmentNode => n.kind === "segment",
    );
  const survivors = new Set(
    presetNames(after.presets).flatMap((preset) =>
      placed(after, preset).map((n) => configureMember(preset, placementId(n))),
    ),
  );
  return presetNames(before.presets).flatMap((preset) =>
    placed(before, preset)
      .map((node) => ({
        preset,
        member: configureMember(preset, placementId(node)),
        node,
      }))
      .filter(({ member }) => !survivors.has(member)),
  );
}

// [LAW:single-enforcer] What a change that ended placements leaves in one
// session, set now: each ended placement's unsaved values, its `✚` libraries
// beside it with their pages, and the configure key while it names that
// placement. A later placement that takes its id is a new instance, and must
// inherit none of it. The one rule for a click's own release and for every
// session a reload changes.
export function endedSessionKeys(
  before: DslConfig,
  after: DslConfig,
  read: (key: string) => string | null,
): readonly string[] {
  const configuring = read(EDIT_CONFIGURE_KEY);
  return endedPlacements(before, after)
    .flatMap(({ preset, member, node }) => [
      ...Object.values(node.drafts ?? {}).map((slot) => slot.key),
      ...(["before", "after"] as const).flatMap((relation) => {
        const { stateKey } = insertGap(preset, placementId(node), relation);
        return [stateKey, menuPageKey(stateKey)];
      }),
      ...(member === configuring ? [EDIT_CONFIGURE_KEY] : []),
    ])
    .filter((key) => read(key) !== null);
}
