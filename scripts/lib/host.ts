import { machineHost, type Host } from "../../src/host";

// [LAW:effects-at-boundaries] The machine this process runs on, as src is
// handed it. A caller that means to be isolated builds its own with `hostOf`,
// naming only the variables it cares about, instead of writing `process.env`.
export const HOST: Host = machineHost();

// A host over the environment a caller states. Its home and temporary
// directory are this process's unless it names them.
export function hostOf(
  env: NodeJS.ProcessEnv,
  rest: Partial<Pick<Host, "home" | "tmp">> = {},
): Host {
  return { env, home: rest.home ?? HOST.home, tmp: rest.tmp ?? HOST.tmp };
}
