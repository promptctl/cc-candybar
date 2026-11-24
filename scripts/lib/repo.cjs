// [LAW:one-source-of-truth] The package root, from this file's own place in
// it, so a tool or a suite drives the checkout its code came from wherever it
// was started. CommonJS, so `__dirname` is there under Jest and tsx alike.
exports.REPO = require("node:path").resolve(__dirname, "..", "..");
