import fs from "node:fs";
import path from "node:path";
// [LAW:one-source-of-truth] THE reading of "this bundle was built in a
// source checkout": the checkout root is the bundle's grandparent
// (`<root>/dist/index.mjs`), and it is a checkout exactly when `<root>/src`
// exists. The installer uses it to recognize a source checkout.
export function sourceCheckoutOf(bundlePath: string): string | null {
  const root = path.dirname(path.dirname(bundlePath));
  return fs.existsSync(path.join(root, "src")) ? root : null;
}

// [LAW:one-source-of-truth] The digest this bundle was stamped with, `null`
// when it carries none (untranspiled under Jest, or built by something other
// than tsdown.config.ts). The one read of `__SOURCE_DIGEST__`: the daemon
// reports its running bundle in stats so a client can tell builds of the
// same version apart. A source checkout rebuilds without bumping the version.
export function bakedDigest(): string | null {
  return typeof __SOURCE_DIGEST__ === "undefined" ? null : __SOURCE_DIGEST__;
}
