import { spawnSync } from "node:child_process";
import { join } from "node:path";

// One real Jest worker runs both files. The teardown verdict must identify
// only the file that kept its period, including an unref'd period.
test("a leaked repeat fails its own file and names the task", () => {
  const root = join(__dirname, "../..");
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/jest/bin/jest.js"),
      "--config",
      "jest.worker.config.js",
      "--runInBand",
      "--reporters",
      "default",
      "--json",
      "--testMatch",
      "**/fixtures/file-periods/*.fixture.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  expect(result.status).toBe(1);
  const { testResults } = JSON.parse(result.stdout) as {
    testResults: Array<{ name: string; status: string; message: string }>;
  };
  expect(testResults).toHaveLength(2);
  expect(
    testResults.find((test) => test.name.endsWith("/leaked.fixture.ts")),
  ).toMatchObject({
    status: "failed",
    message: expect.stringContaining("fixture leaked feed (60000 ms)"),
  });
  expect(
    testResults.find((test) => test.name.endsWith("/released.fixture.ts")),
  ).toMatchObject({
    status: "passed",
  });
});
