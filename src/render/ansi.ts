import { OSC8 } from "@promptctl/rich-js";

/**
 * Every escape in a serialized line that occupies no columns: SGR, and OSC 8
 * hyperlink opens/closes.
 *
 * [LAW:one-source-of-truth] The OSC 8 half is rich-js's own grammar — the
 * library that writes the bytes is the one that says how to read them — so a
 * change to how links are written (an `id=` param, a BEL terminator) cannot
 * leave a width measure here counting escape bytes as visible text.
 */
export const INVISIBLE = new RegExp(`\\x1b\\[[0-9;]*m|${OSC8.source}`, "g");
