// [LAW:one-source-of-truth] The test suite's reader of the package version
// stamp — the source-run counterpart of tsdown's `define`. src/version.ts
// throws at load when `__PACKAGE_VERSION__` is unsubstituted, so every process
// that runs untranspiled source needs this: the Jest worker requires it from
// test/setup.ts, and the same setup appends it to NODE_OPTIONS (`--import`) so
// every child the worker spawns — the tsx test daemon and the production
// `node <script> daemon` path alike — inherits the stamp. CommonJS so plain
// `node`, `tsx`, and Jest's sandbox all load it with no transform.
const { version } = require("../../package.json");
globalThis.__PACKAGE_VERSION__ = version;
