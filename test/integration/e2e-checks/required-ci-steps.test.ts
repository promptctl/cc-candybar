import { repoOnDisk, workflowsOnDisk } from "../../e2e-checks/repo-on-disk";
import { isJest, jestConfigOf, leafCommands, stepsOf } from "../../e2e-checks/workflow-daemons";

// What the workflows must keep running for the cap and the assertion limit to
// bind. release.yml is not under the hook, so a deleted step turns this red.
// Each row is a predicate over the commands a step resolves to once package
// scripts are expanded.

const repo = repoOnDisk();
const commandsRun = workflowsOnDisk().flatMap(({ name, text }) =>
  stepsOf(text, name).flatMap((step) => leafCommands(step.run, repo)),
);

test("a CI step runs jest with the end-to-end config, the only run of test/e2e/", () => {
  expect(commandsRun.some((tokens) => isJest(tokens) && jestConfigOf(tokens) === "jest.e2e.config.js")).toBe(true);
});
