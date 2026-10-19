// [LAW:one-type-per-behavior] One platform → one package name; the render
// entry is the same contract everywhere, only the artifact differs.
// [LAW:one-source-of-truth] The one list of platforms a native client ships
// for: `install` stages from it, and the doctor reads it to know whether the
// Node fallback was the only client there is.
export const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@promptctl/cc-candybar-darwin-arm64",
  "darwin-x64": "@promptctl/cc-candybar-darwin-x64",
  "linux-x64": "@promptctl/cc-candybar-linux-x64",
  "linux-arm64": "@promptctl/cc-candybar-linux-arm64",
};

export function shipsNative(platform: string, arch: string): boolean {
  return `${platform}-${arch}` in PLATFORM_PACKAGES;
}
