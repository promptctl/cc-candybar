import type { ConfigSnapshot, Layer } from "../../src/config/config-snapshot";
import type { RenderOrigin } from "../../src/config-hint";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { EditTransactions } from "../../src/renderer/edit-transaction";
import { SessionState } from "../../src/renderer/session-state";
import { parseAndValidate } from "../helpers/parse-and-validate";
import { insertGap } from "../../src/config/edit-chrome";
import {
  SettingsHistory,
  type ConfigFiles,
} from "../../src/renderer/settings-history";

type Standing = NonNullable<ConfigSnapshot["repo"]>["standing"];
const origin: RenderOrigin = {
  projectDir: "/checkout",
  cwd: "/checkout",
  target: { source: "search" },
};
const sid = sessionIdOf("editing");
const other = sessionIdOf("peer");

const userText = "{ globals: { padding: 1 } }";
const user: Layer = {
  role: "user",
  path: "/home/config.json5",
  content: { kind: "text", text: userText },
  listed: {},
};
const project: Layer = {
  role: "project",
  path: "/checkout/config.json5",
  content: { kind: "text", text: "{}" },
  listed: {},
};

function snapshot(standing: Standing): ConfigSnapshot {
  const approved = standing === "approved";
  return {
    chain: approved ? [user, project] : [user],
    repo: { standing, dir: origin.cwd, unproven: null },
    checkout: { root: origin.cwd, git: true },
    plugins: approved
      ? [
          {
            scope: "repo",
            path: "/checkout/sample.json5",
            definition: { kind: "text", text: "{}", dir: origin.cwd },
          },
        ]
      : [],
    strays: [],
    notices: [],
    watch: null,
  };
}

test("the draft keeps its edits but follows live repository trust", () => {
  const committed = new SessionState();
  const layout = parseAndValidate("<test>", "{}");
  const edits = new EditTransactions(committed, () => {});
  edits.open(sid, origin, snapshot("approved"), layout);
  const turn = edits.draft(sid)!.begin(
    () => {},
    () => layout,
  );
  const edited = "{ globals: { padding: 2 } }";
  turn.journal.file(sid, user.path, userText, edited);
  turn.journal.sessionState.set(sid, "theme", "nord");
  turn.commit();

  const refused = snapshot("declined");
  expect(edits.configured(origin, refused, () => layout)).toEqual([sid]);
  const preview = edits.snapshot(origin, sid)!;
  expect(preview.repo).toEqual(refused.repo);
  expect(preview.plugins).toEqual([]);
  expect(preview.chain).toEqual([
    { ...user, content: { kind: "text", text: edited } },
  ]);
  expect(edits.snapshot(origin, other)).toBeNull();
  expect(edits.view.get(sid, "theme")).toBe("nord");
  expect(committed.get(sid, "theme")).toBeNull();
});

// A refresh of the edit's layers (a repository's trust revoked, a plugin
// gone) can end a placement as a click can: what it held ends with it, and
// chrome the new layout mints is the edit's to hold.
test("a refresh that ends a placement releases its chrome", () => {
  const committed = new SessionState();
  const layout = (root: string) =>
    parseAndValidate(
      "<test>",
      `{ segments: { x: { template: 'X' }, y: { template: 'Y' }, z: { template: 'Z' } }, root: { h: ${root} } }`,
    );
  const both = layout("['x', 'y']");
  const edits = new EditTransactions(committed, () => {});
  edits.open(sid, origin, snapshot("approved"), both);
  const afterX = insertGap("default", "x", "after");
  const afterZ = insertGap("default", "z", "after");
  expect(both.variables[afterX.stateKey]).toBeDefined();
  const turn = edits.draft(sid)!.begin(() => {}, () => both);
  turn.journal.sessionState.set(sid, afterX.stateKey, afterX.apply);
  turn.commit();
  expect(edits.view.get(sid, afterX.stateKey)).toBe(afterX.apply);

  edits.configured(origin, snapshot("declined"), () => layout("['y', 'z']"));
  expect(edits.view.get(sid, afterX.stateKey)).toBeNull();
  const next = edits.draft(sid)!.begin(() => {}, () => layout("['y', 'z']"));
  next.journal.sessionState.set(sid, afterZ.stateKey, afterZ.apply);
  next.commit();
  expect(edits.view.get(sid, afterZ.stateKey)).toBe(afterZ.apply);
  expect(committed.get(sid, afterX.stateKey)).toBeNull();
  expect(committed.get(sid, afterZ.stateKey)).toBeNull();
});

// Save hands the store what the edit leaves it: the save click's own writes
// pass the draft's routing, so a setting lands and chrome ends with the edit.
test("a save click's own chrome write never reaches the store", () => {
  const committed = new SessionState();
  const config = parseAndValidate(
    "<test>",
    `{ segments: { x: { template: 'X' } }, root: { h: ['x'] } }`,
  );
  const edits = new EditTransactions(committed, () => {});
  edits.open(sid, origin, snapshot("approved"), config);
  const gap = insertGap("default", "x", "after");
  const files = {} as ConfigFiles;
  const turn = edits.draft(sid)!.begin(
    () => {},
    () => config,
  );
  turn.journal.sessionState.set(sid, "theme", "nord");
  turn.journal.sessionState.set(sid, gap.stateKey, gap.apply);
  const saved = new SettingsHistory(committed, () => {}).begin(files);
  turn.save(saved, files, snapshot("approved"));
  saved.commit();
  expect(committed.get(sid, "theme")).toBe("nord");
  expect(committed.get(sid, gap.stateKey)).toBeNull();
});
