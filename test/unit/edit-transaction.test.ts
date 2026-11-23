import type { ConfigSnapshot, Layer } from "../../src/config/config-snapshot";
import type { RenderOrigin } from "../../src/config-hint";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { EditTransactions } from "../../src/renderer/edit-transaction";
import { SessionState } from "../../src/renderer/session-state";
import { EDIT_MODE_KEY } from "../../src/config/reserved-names";
import { EDIT_MODE_ARRANGE } from "../../src/config/loader/edit-mode";
import { DISCLOSURE_CLOSED } from "../../src/config/disclosure";

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
            definition: {
              kind: "text",
              text: "{}",
              dir: origin.cwd,
              storage: `${origin.cwd}/session`,
            },
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
  const edits = new EditTransactions(committed, () => {});
  edits.open(sid, origin, snapshot("approved"), new Map());
  const turn = edits.draft(sid)!.begin(() => {});
  const edited = "{ globals: { padding: 2 } }";
  turn.journal.file(sid, user.path, userText, edited);
  turn.journal.sessionState.set(sid, "theme", "nord");
  turn.commit();

  const refused = snapshot("declined");
  expect(edits.configured(origin, refused)).toEqual([sid]);
  const preview = edits.revision(origin, sid)!.snapshot;
  expect(preview.repo).toEqual(refused.repo);
  expect(preview.plugins).toEqual([]);
  expect(preview.chain).toEqual([
    { ...user, content: { kind: "text", text: edited } },
  ]);
  expect(edits.revision(origin, other)).toBeNull();
  expect(edits.view.get(sid, "theme")).toBe("nord");
  expect(committed.get(sid, "theme")).toBeNull();
});

test("an open edit reads as arranging with no write of its mode, and a write of it reads as written", () => {
  const committed = new SessionState();
  const edits = new EditTransactions(committed, () => {});
  expect(edits.view.get(sid, EDIT_MODE_KEY)).toBeNull();
  edits.open(sid, origin, snapshot("approved"), new Map());
  expect(edits.view.get(sid, EDIT_MODE_KEY)).toBe(EDIT_MODE_ARRANGE);
  edits.view.set(sid, EDIT_MODE_KEY, DISCLOSURE_CLOSED);
  expect(edits.view.get(sid, EDIT_MODE_KEY)).toBe(DISCLOSURE_CLOSED);
  expect(committed.get(sid, EDIT_MODE_KEY)).toBeNull();
});
