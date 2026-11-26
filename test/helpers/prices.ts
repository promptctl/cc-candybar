import { bundledTable, type Prices } from "../../src/daemon/cache/pricing";

// A price source already settled on the bundled rates: what a store prices by
// in a case that is not about loading the table.
export const settledPrices: Prices = {
  table: () => Promise.resolve(bundledTable()),
};
