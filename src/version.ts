declare const __PACKAGE_VERSION__: string;

// [LAW:one-source-of-truth] package.json is the sole authority for this stamp. [LAW:no-silent-failure] A runtime that cannot say what it is must say THAT.
if (typeof __PACKAGE_VERSION__ === "undefined") {
  throw new Error(
    "__PACKAGE_VERSION__ was not substituted: build via tsdown (define), or preload scripts/version-stamp.cjs when running source",
  );
}

export const PACKAGE_VERSION: string = __PACKAGE_VERSION__;
