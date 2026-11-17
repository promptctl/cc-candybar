// A config snapshot as the host's discovery would hand one in, built from
// texts a test states: its layers in chain order, the user's at the bottom,
// with no repository, plugins or notices.

import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import type { LayerRole } from "../../src/config/layer-role";
import { pluginRefsOf } from "../../src/config/dsl-loader";
import { listedPath } from "../../src/config/loader/plugins";
import {
  readPluginFile,
  scopeOf,
} from "../../src/daemon/config-discovery/discovery";

const ROLES: readonly LayerRole[] = ["user", "project", "local"];

// With `home`, each layer's listed definitions are read from disk as
// discovery reads them; without, a layer lists none.
export function textSnapshot(
  layers: ReadonlyArray<readonly [path: string, text: string]>,
  cwd = "/",
  home?: string,
): ConfigSnapshot {
  if (layers.length > ROLES.length)
    throw new Error(`a chain holds at most ${ROLES.length} layers`);
  return {
    chain: layers.map(([path, text], i) => {
      const role = ROLES[i]!;
      return {
        role,
        path,
        content: { kind: "text", text },
        listed:
          home === undefined
            ? {}
            : Object.fromEntries(
                pluginRefsOf(text).map((ref) => [
                  ref,
                  readPluginFile(listedPath(ref, path, home), scopeOf(role)),
                ]),
              ),
      };
    }),
    repo: null,
    plugins: [],
    strays: [],
    checkout: { root: cwd, git: false },
    notices: [],
    watch: null,
  };
}
