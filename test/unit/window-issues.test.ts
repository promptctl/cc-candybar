import { WindowIssues } from "../../src/bar-window/issues";

test("hide and ready acknowledgements cannot clear a failed tmux placement", () => {
  const published: string[] = [];
  const issues = new WindowIssues((reason) => published.push(reason));
  issues.setLayout("tmux could not reserve four rows");
  issues.setSurface("");
  issues.setSurface("another surface failure");
  expect(published).toEqual(["tmux could not reserve four rows"]);
  issues.setLayout("");
  expect(published.at(-1)).toBe("another surface failure");
  issues.setSurface("");
  expect(published.at(-1)).toBe("");
});
