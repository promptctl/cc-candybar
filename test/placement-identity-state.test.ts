// A placement's session state is filed under what the placement is: its
// preset, its id and its segment (src/config/placement-identity.ts). Each test
// draws through the real click and render path over one session's state, and
// changes only the part of the identity it is about.

import { textOf } from "../src/render/frame";
import { SessionState } from "../src/renderer/session-state";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { placementDraftKey } from "../src/config/edit-chrome";
import { effectsOf, landsAt } from "./helpers/click";
import { linkUrls } from "./helpers/frame";
import { menuKeyOf } from "./helpers/menu-key";
import { buildRig } from "./helpers/rig";
import { picked, selectionFor } from "../scripts/lib/draw-fixtures/selection";

const S1 = sessionIdOf("s1");
const OPEN = "applyTheme";

function bar(source: string, sessionState: SessionState) {
  const rig = buildRig({ source, sessionId: S1, sessionState });
  const drawIn = (preset?: string) =>
    rig.draw({
      selection:
        preset === undefined
          ? undefined
          : selectionFor(rig.config, {}, picked({ preset })),
    });
  const open = async (key: string, preset?: string): Promise<void> => {
    const url = linkUrls(drawIn(preset).frame).find((u) =>
      effectsOf(u).some((e) => landsAt(rig.config, e, key, OPEN)),
    );
    if (url === undefined) throw new Error(`no toggle for ${key}`);
    await rig.click(url);
  };
  const shows = (preset?: string): string => textOf(drawIn(preset).frame);
  return { rig, drawIn, open, shows };
}

const MENU = `'{{ menu "${OPEN}" "▸" "▾" }}'`;
const ACTION = `actions: { ${OPEN}: { set: 'theme', from: 'themes' } },`;

describe("two presets whose placements share an id", () => {
  const SRC = `{
    ${ACTION}
    segments: { picker: { template: ${MENU} } },
    presets: {
      a: { root: { h: [{ seg: 'picker', id: 'x' }] } },
      b: { root: { h: [{ seg: 'picker', id: 'x' }] } },
    },
  }`;

  test("opening the menu in one leaves the other's closed", async () => {
    const state = new SessionState();
    const rt = bar(SRC, state);
    await rt.open(menuKeyOf("picker", OPEN, "x", "a"), "a");
    expect(rt.shows("a")).toContain("▾");
    expect(rt.shows("b")).toContain("▸");
    expect(rt.shows("b")).not.toContain("▾");
    expect(state.get(S1, menuKeyOf("picker", OPEN, "x", "b"))).toBeNull();
  });
});

describe("a placement whose segment changes under a kept id", () => {
  const withSegment = (segment: string): string => `{
    ${ACTION}
    segments: {
      ${segment}: {
        template: ${MENU},
        settings: { n: { label: 'n', domain: { min: 1, max: 9 }, default: 1 } },
      },
    },
    root: { h: [{ seg: '${segment}', id: 'x' }] },
  }`;

  test("starts with the menu closed, though the old segment's was open", async () => {
    const state = new SessionState();
    await bar(withSegment("before"), state).open(
      menuKeyOf("before", OPEN, "x"),
    );
    expect(bar(withSegment("before"), state).shows()).toContain("▾");
    expect(bar(withSegment("after"), state).shows()).toContain("▸");
    expect(bar(withSegment("after"), state).shows()).not.toContain("▾");
  });

  test("reads none of the old segment's draft of a setting the new one names alike", () => {
    const state = new SessionState();
    const identity = (segment: string) => ({
      preset: "default",
      id: "x",
      segment,
    });
    state.set(S1, placementDraftKey(identity("before"), "n"), "7");
    const key = (segment: string) => placementDraftKey(identity(segment), "n");
    expect(key("after")).not.toBe(key("before"));
    // The draft under the segment it was written for is the one a placement
    // of that segment reads, and a placement of the other reads its default.
    const text = (segment: string): string => {
      const source = withSegment(segment).replace(
        `template: ${MENU}`,
        "template: '{{ .settings.n }}'",
      );
      return bar(source, state).shows();
    };
    expect(text("before")).toContain("7");
    expect(text("after")).not.toContain("7");
  });
});

describe("placements whose ids differ only in punctuation", () => {
  const SRC = `{
    ${ACTION}
    segments: { picker: { template: ${MENU} } },
    root: { h: [{ seg: 'picker', id: 'seg-2' }, { seg: 'picker', id: 'seg_2' }] },
  }`;

  test("each hosts a menu and holds its own open state", async () => {
    const state = new SessionState();
    const rt = bar(SRC, state);
    const dashed = menuKeyOf("picker", OPEN, "seg-2");
    const underscored = menuKeyOf("picker", OPEN, "seg_2");
    expect(dashed).not.toBe(underscored);
    expect(rt.rig.config.variables[dashed]).toBeDefined();
    expect(rt.rig.config.variables[underscored]).toBeDefined();
    await rt.open(dashed);
    expect(state.get(S1, dashed)).toBe(OPEN);
    expect(state.get(S1, underscored)).toBeNull();
    // One body hangs open, and the other placement still offers its ▸.
    expect(rt.shows()).toContain("▾");
    expect(rt.shows()).toContain("▸");
  });
});
