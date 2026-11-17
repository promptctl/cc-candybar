// The chain a search resolves, without the repository question it asks: what
// a test of the precedence and the gate reads.

import { searchConfig } from "../../src/daemon/config-discovery/config-search";
import type { ConfigResolution } from "../../src/config/loader/chain-places";

export const resolutionOf = (
  ...args: Parameters<typeof searchConfig>
): ConfigResolution => searchConfig(...args).resolution;
