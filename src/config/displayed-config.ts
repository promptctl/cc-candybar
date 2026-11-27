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

export function isDisplayDigest(value: unknown): value is DisplayDigest {
  return (
    typeof value === "string" &&
    value.length === DISPLAY_DIGEST_HEX &&
    /^[0-9a-f]+$/.test(value)
  );
}

export function displayedConfigFromHex(
  hex: string,
): DisplayedConfig | undefined {
  const origin = hex.slice(0, DISPLAY_DIGEST_HEX),
    files = hex.slice(DISPLAY_DIGEST_HEX);
  return isDisplayDigest(origin) && isDisplayDigest(files)
    ? { origin, files }
    : undefined;
}
