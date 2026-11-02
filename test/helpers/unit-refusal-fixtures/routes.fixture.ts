import os from "node:os";
import path from "node:path";

import { FS_DESCRIPTOR_OPS } from "../unit-refusal";
import { MODULES, routesIn } from "../unit-refusal-routes";

// One case per route in the table, cut from the real module the way the guard
// was, and each calls its route through the module a test would import. The
// argument is a path that exists nowhere, so a guard that is missing fails the
// case by a different error and does no harm. A descriptor operation passes by
// design, since its open was judged.

const arg = path.join(os.tmpdir(), "unit-refusal-route");

const at = (root: unknown, route: readonly string[]): unknown =>
  route.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);

for (const [, name, guarding] of MODULES) {
  const real = jest.requireActual<Record<string, unknown>>(name);
  for (const route of routesIn(name, real, guarding)) {
    if (FS_DESCRIPTOR_OPS.has(route.path.at(-1) ?? "")) continue;
    test(route.call, () => {
      const target = at(require(name), route.path) as (...args: unknown[]) => unknown;
      if (route.kind === "class") Reflect.construct(target, [arg]);
      else target(arg);
    });
  }
}
