import type { ConfigSnapshot, Layer } from "../../src/config/config-snapshot";
import type { RenderOrigin } from "../../src/config-hint";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { EditTransactions } from "../../src/renderer/edit-transaction";
import { SessionState } from "../../src/renderer/session-state";

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
            definition: { kind: "text", text: "{}", dir: origin.cwd, storage: `${origin.cwd}/session` },
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
  edits.open(sid, origin, snapshot("approved"));
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
