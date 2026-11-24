// What each launcher fixture file runs, through jest.launcher-fixtures.config.js
// (run only by test/integration/fixture-launchers.test.ts). Every file checks
// that no lifeline an earlier file recorded still runs, then holds one of its
// own through its last hook and records it. Whichever file the worker runs
// second checks the first, whatever order jest picks.

import fs from "node:fs";
import path from "node:path";

import { fixtureLauncher, processProbe } from "../host";

export const LIFELINE_DIR_ENV = "CC_CANDYBAR_LIFELINE_DIR";

export function lifelineAcrossFiles(file: string): void {
  const dir = process.env[LIFELINE_DIR_ENV];
  if (dir === undefined) throw new Error(`${LIFELINE_DIR_ENV} names no directory`);
  let pid: number | undefined;

  test("no lifeline an earlier file held still runs", () => {
    const earlier = fs
      .readdirSync(dir)
      .map((name) => Number(fs.readFileSync(path.join(dir, name), "utf8")));
    expect(earlier.filter(processProbe.alive)).toEqual([]);
  });

  test("this file's launcher holds a lifeline", async () => {
    const launcher = fixtureLauncher({ inherited: process.env });
    expect(
      await launcher.launch({ bin: "/bin/echo", category: "user-shell" }),
    ).toMatchObject({ ok: true });
    pid = launcher.__lifelineForTest().pid;
    expect(pid).toEqual(expect.any(Number));
    fs.writeFileSync(path.join(dir, file), String(pid));
  });

  // The file's own last hook still has its lifeline: the release comes after.
  afterAll(() => {
    expect(pid !== undefined && processProbe.alive(pid)).toBe(true);
  });
}
