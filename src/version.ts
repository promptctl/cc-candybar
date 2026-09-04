// [LAW:one-source-of-truth] THE version stamp of this runtime. package.json is
// the sole authority: tsdown's `define` bakes it into the bundle, and
// scripts/version-stamp.cjs preloads it for untranspiled source. Every consumer
// — `--version`, the install banner, the daemon's stats snapshot — reads this
// one export.
declare const __PACKAGE_VERSION__: string;

// [LAW:no-silent-failure] A runtime that cannot say what it is must say THAT.
// The old `"dev"` fallback was an answer-shaped void in a flag whose whole job
// is answering this question; an unsubstituted build now fails at module load.
if (typeof __PACKAGE_VERSION__ === "undefined") {
  throw new Error(
    "__PACKAGE_VERSION__ was not substituted: build via tsdown (define), or preload scripts/version-stamp.cjs when running source",
  );
}

export const PACKAGE_VERSION: string = __PACKAGE_VERSION__;
