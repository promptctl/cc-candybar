// A fixture launcher ends with the file that made it: a Jest worker runs many
// files in one process, so a lifeline left to the process outlives its file.

import { spawnSync } from "node:child_process";

import { fixtureLauncher, releaseFixtureLaunchers } from "../helpers/host";

test("a file's release ends the lifeline each of its fixture launchers started", async () => {
  // The environment, from its own realm, hands every file the hook this
  // module registers through.
  expect(typeof globalThis.releaseTestFixture).toBe("function");
  const launcher = fixtureLauncher({ inherited: process.env });
  expect(
    await launcher.launch({ bin: "/bin/echo", category: "user-shell" }),
  ).toMatchObject({ ok: true });
  const { pid } = launcher.__lifelineForTest();
  expect(pid).toEqual(expect.any(Number));

  await releaseFixtureLaunchers();

  expect(spawnSync("kill", ["-0", String(pid)]).status).not.toBe(0);
});
