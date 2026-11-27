import { inspect } from "node:util";
import { classified, type Failure } from "./verb-error.js";

// Host logs retain the native stack of a local failure.
export const failureOf = (value: unknown): Failure =>
  classified(value, inspect);
