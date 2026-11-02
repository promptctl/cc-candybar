import { workflowsOnDisk } from "../e2e-checks/repo-on-disk";
import { stepsOf } from "../e2e-checks/workflow-daemons";

// The step that holds the excused list to shrinking, pinned in all three parts:
// the pull_request guard, the list file and the base commit. A step that compares
// the file with itself, or runs on pushes where there is no base, fails here.
// Deleted with the list by candybar-testing-ihvy.4vv.

const EXPECTED_RUN =
  "node scripts/check-shrinks.cjs test/transitional-daemon-workflows/excused-workflows.json " +
  "${{ github.event.pull_request.base.sha }}";

test("release.yml runs check-shrinks on the excused list against the pull request's base", () => {
  const release = workflowsOnDisk().find(({ name }) => name === "release.yml")!;
  const steps = stepsOf(release.text, "release.yml").filter((step) => step.run.trim() === EXPECTED_RUN);
  expect(steps.map((step) => step.condition)).toEqual(["github.event_name == 'pull_request'"]);
});
