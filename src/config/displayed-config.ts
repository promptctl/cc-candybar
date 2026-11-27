import { digestOf, type Plain } from "../utils/plain.js";

// [LAW:types-are-the-program] Both addresses are 96-bit content identities.
// The separate 128-bit link MAC authenticates the action and its addresses.
declare const DISPLAY_DIGEST: unique symbol;
export type DisplayDigest = string & { readonly [DISPLAY_DIGEST]: true };
const DISPLAY_DIGEST_HEX = 24;

export function displayDigestOf<T>(value: T & Plain<T>): DisplayDigest {
  return digestOf<T>(value).slice(0, DISPLAY_DIGEST_HEX) as DisplayDigest;
}

export interface DisplayedConfig {
  readonly origin: DisplayDigest;
  readonly files: DisplayDigest;
}

export function displayedConfigFromHex(
  hex: string,
): DisplayedConfig | undefined {
  if (hex.length !== DISPLAY_DIGEST_HEX * 2 || !/^[0-9a-f]+$/.test(hex))
    return undefined;
  return {
    origin: hex.slice(0, DISPLAY_DIGEST_HEX) as DisplayDigest,
    files: hex.slice(DISPLAY_DIGEST_HEX) as DisplayDigest,
  };
}
