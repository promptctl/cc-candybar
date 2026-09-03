import { readFileSync } from "node:fs";
import { join } from "node:path";

// package.json is the version's sole authority; the tests read it the same way
// the build does rather than restating the number.
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };

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
});
