import { repoOnDisk, workflowsOnDisk } from "../e2e-checks/repo-on-disk";
import { violationsOf } from "../e2e-checks/workflow-daemons";
import excused from "../transitional-daemon-workflows/excused-workflows.json";

// [LAW:single-enforcer] The start judge sees jest only, so the Load gate stayed
// outside the five end-to-end tests. This reads the repository's own workflows
// and fails on a step that reaches a daemon. `pnpm bench`, `pnpm bar` and
// `pnpm bar:web` start one for a person to look at; this keeps them out of CI.

test("no workflow step reaches a daemon, but the workflows the transitional list excuses", () => {
  expect(violationsOf(workflowsOnDisk(), repoOnDisk(), excused)).toEqual([]);
});

test("the Load gate workflow is the one that reaches a daemon today", () => {
  expect(violationsOf(workflowsOnDisk(), repoOnDisk(), []).map((v) => v.workflow)).toEqual(
    expect.arrayContaining(["load-gate.yml"]),
  );
});
