// [LAW:verifiable-goals] A placement's session state is named by the keys
// edit chrome and edit mode mint for it, and the code that mints them says
// which placement each belongs to; the one release rule ends the keys of every
// placement a config no longer holds, and nothing else.

import {
  placementDraftKey,
  placementOwning,
  placementsOf,
} from "../../src/config/edit-chrome";
import { configureMember } from "../../src/config/loader/edit-mode";
import { escapedIdent } from "../../src/config/ident";
import { parseAndPlace } from "../helpers/parse-and-validate";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import { SessionState } from "../../src/renderer/session-state";
import {
  releaseAtLoad,
  releaseSession,
  SESSION_CONFIG_KEY,
} from "../../src/renderer/placement-release";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");
const ALLOWED = new Set(listResolvablePaletteNames());

// A preset and an id that both need escaping, placed beside a plain one, and
// an author menu hosted by a placement of its own.
const SRC = `{
  segments: {
    vcs: {
      template: 'v',
      settings: { form: { label: 'form', domain: ['short', 'long'], default: 'short' } },
    },
    host: { template: '{{ menu "pick" "▸" "▾" }}' },
  },
  actions: { pick: { set: 'mode', from: ['a', 'b'] } },
  variables: { mode: { kind: 'state', key: 'mode', default: 'a' } },
  presets: { 'my preset': {} },
  root: { h: ['vcs', { seg: 'vcs', id: 'git-2.x' }, 'host'] },
}`;

describe("the minter says which placement a key belongs to", () => {
  const { config, placed } = parseAndPlace("<test>", SRC, ALLOWED);
  // Every session key the load declares: what a session can hold.
  const keys = Object.values(config.variables).flatMap((v) =>
    v.kind === "state" ? [v.key] : [],
  );

  test.each([
    ["default", "vcs"],
    ["my preset", "git-2.x"],
  ])("every key minted for %s's placement %s answers it", (preset, id) => {
    const member = configureMember(preset, id);
    const escaped = escapedIdent(id);
    const minted = keys.filter(
      (key) =>
        key.includes(`_${escaped}`) &&
        key.includes(escapedIdent(preset)) &&
        !key.includes(`_${escaped}Z`),
    );
    // Its controls' list, that list's page, and a `✚` library and its page
    // on each side of the first placement or after any other.
    expect(minted.length).toBeGreaterThanOrEqual(4);
    for (const key of minted)
      expect([key, placementOwning(key, "closed")]).toEqual([key, member]);
    const draft = placementDraftKey(escapedIdent(preset), id, "form");
    expect(keys).toContain(draft);
    expect(placementOwning(draft, "long")).toBe(member);
    expect(placementOwning("edit.configure", member)).toBe(member);
  });

  test("an author's menu, edit mode itself and a closed configure key answer nothing", () => {
    // The author's menu is keyed by its host placement's id.
    const author = keys.filter((key) =>
      /^menu(pages\.menu)?s\.host\./.test(key),
    );
    expect(author.length).toBeGreaterThan(0);
    for (const key of [...author, "edit.mode", "mode", "click.error"])
      expect([key, placementOwning(key, "open")]).toEqual([key, null]);
    expect(placementOwning("edit.configure", "closed")).toBeNull();
  });

  test("a config holds each placement of each preset's tree", () => {
    expect(placementsOf(placed)).toEqual(
      new Set(
        ["default", "my preset"].flatMap((preset) =>
          ["vcs", "git-2.x", "host"].map((id) => configureMember(preset, id)),
        ),
      ),
    );
  });
});

describe("the release ends a placement's state and nothing beside it", () => {
  const held = configureMember("default", "vcs");
  const gone = configureMember("default", "gone");
  const goneDraft = placementDraftKey("default", "gone", "form");
  const keptDraft = placementDraftKey("default", "vcs", "form");

  const seeded = (): SessionState => {
    const store = new SessionState();
    for (const sid of [S1, S2])
      store.setBatch(sid, [
        { key: goneDraft, value: "long" },
        { key: keptDraft, value: "long" },
        { key: "edit.configure", value: gone },
        { key: "mode", value: "b" },
      ]);
    return store;
  };

  test("one session: the ended placement's keys go, and the log names them", () => {
    const store = seeded();
    const lines: string[] = [];
    releaseSession(store, S1, new Set([held]), "C", (_l, m) => lines.push(m));
    expect(store.keys(S1)).toEqual([keptDraft, "mode"]);
    expect(store.keys(S2)).toHaveLength(4);
    expect(lines).toEqual([
      `placement state released session="s1" config=C keys=${JSON.stringify([goneDraft, "edit.configure"])}`,
    ]);
  });

  test("a load reaches only the sessions whose state belongs to its config", () => {
    const store = seeded();
    store.set(S1, SESSION_CONFIG_KEY, "C");
    store.set(S2, SESSION_CONFIG_KEY, "D");
    releaseAtLoad(store, new Set([held]), "C", () => {});
    expect(store.get(S1, goneDraft)).toBeNull();
    expect(store.get(S2, goneDraft)).toBe("long");
  });
});
