// [LAW:one-type-per-behavior] One platform → one package name; the render
// entry is the same contract everywhere, only the artifact differs.
// [LAW:one-source-of-truth] The one list of platforms a native client ships
// for: `install` stages from it.
export const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@promptctl/cc-candybar-darwin-arm64",
  "darwin-x64": "@promptctl/cc-candybar-darwin-x64",
  "linux-x64": "@promptctl/cc-candybar-linux-x64",
  "linux-arm64": "@promptctl/cc-candybar-linux-arm64",
};

// [LAW:effects-at-boundaries] The key of the machine this process runs on, read
// where install stages: the lookups below take a key, so a test names the
// platform it means.
export const machinePlatform = (os: NodeJS.Platform = process.platform): string =>
  `${os}-${process.arch}`;

export function shipsNative(platform: string, arch: string): boolean {
  return `${platform}-${arch}` in PLATFORM_PACKAGES;
}
