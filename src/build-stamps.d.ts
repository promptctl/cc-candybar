// [LAW:one-source-of-truth] The digest of the `src/` tree this bundle was
// built from, baked by tsdown.config.ts's source-digest plugin on EVERY
// build (watch rebuilds included — the sole reason it is a per-build
// transform and not a static `define` like __PACKAGE_VERSION__ in
// src/version.ts). Ambient rather than an inline `declare const` because the
// plugin substitutes the token textually, and an inline declaration would be
// rewritten into a syntax error. Absent when the code runs untranspiled or
// was bundled by anything else; the one reader (src/daemon/build-currency.ts)
// treats that as a typed "cannot check", never as current.
declare const __SOURCE_DIGEST__: string;
