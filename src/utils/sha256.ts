import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// [LAW:one-source-of-truth] Callers own their preimage. Wire identities
// use the same UTF-8 encoding and lowercase digest in each engine.
export const sha256Text = (value: string): string =>
  bytesToHex(sha256(utf8ToBytes(value)));
