import fs from "node:fs";
import { sep } from "node:path";

type Operation =
  | "opendirSync"
  | "readdirSync"
  | "statSync"
  | "openSync"
  | "renameSync"
  | "lstatSync";

// [LAW:effects-at-boundaries] Supply the filesystem's permission refusal for
// this fixture only. The remaining files and operations use the real disk.
export function refuseFile(
  at: string | { below: string },
  ...operations: Operation[]
): Disposable {
  const root = typeof at === "string" ? at : at.below;
  const roots = [root, fs.realpathSync(root)];
  const refused = (path: string) =>
    roots.some((base) =>
      typeof at === "string" ? path === base : path.startsWith(base + sep),
    );
  const spies = operations.map((op) => {
    const call = fs[op];
    return jest.spyOn(fs, op).mockImplementation((...args) => {
      const [path] = args;
      if (typeof path === "string" && refused(path)) {
        const syscall = op.replace(/Sync$/, "");
        throw Object.assign(
          new Error(`EACCES: permission denied, ${syscall} '${path}'`),
          { code: "EACCES", path, syscall },
        );
      }
      return Reflect.apply(call, fs, args);
    });
  });
  return { [Symbol.dispose]: () => spies.forEach((spy) => spy.mockRestore()) };
}
