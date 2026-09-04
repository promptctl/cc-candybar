import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// package.json is the version's sole authority; the tests read it the same way
// the build does rather than restating the number.
const pkg = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
) as { version: string };

describe("PACKAGE_VERSION", () => {
  test("is the package.json version", async () => {
    const { PACKAGE_VERSION } = await import("../src/version");
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  // [LAW:no-silent-failure] An unsubstituted build must not answer with a
  // plausible word ("dev"); loading the module without the stamp is an error.
  test("refuses to load when __PACKAGE_VERSION__ was never substituted", async () => {
    const g = globalThis as { __PACKAGE_VERSION__?: string };
    const saved = g.__PACKAGE_VERSION__;
    delete g.__PACKAGE_VERSION__;
    try {
      jest.resetModules();
      await expect(import("../src/version")).rejects.toThrow(
        /__PACKAGE_VERSION__ was not substituted/,
      );
    } finally {
      g.__PACKAGE_VERSION__ = saved;
      jest.resetModules();
    }
  });

  // The answering side of the Rust routing test: every spelling the native
  // client forwards prints the same one line and exits 0, with nothing on stdin.
  test.each(["--version", "-V"])(
    "%s prints `cc-candybar <version>`",
    (flag) => {
      const r = spawnSync(
        join(process.cwd(), "node_modules", ".bin", "tsx"),
        [join(process.cwd(), "src", "index.ts"), flag],
        {
          env: process.env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`cc-candybar ${pkg.version}\n`);
    },
  );
});
