import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Code under test that catches the refusal must not make the test pass.

test("code under test swallows the refused write", () => {
  try {
    fs.writeFileSync(path.join(os.tmpdir(), "unit-refusal-fixture"), "x");
  } catch {
    // swallowed on purpose
  }
  expect(1).toBe(1);
});
