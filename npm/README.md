# Per-platform binary packages

Each subdirectory is a separate npm package containing only the prebuilt
native render-path binary for one OS/arch pair. The main `@promptctl/cc-candybar`
package is published declaring all four under `optionalDependencies`; npm/pnpm install
only the one matching the host's `os` + `cpu` constraints.

The `version` field in each `package.json` is `0.0.0-PLACEHOLDER` in source
control. CI rewrites it to match the main package's release version before
publishing (`scripts/publish.mjs`, run for a pushed release tag). The binary is placed at `bin/cc-candybar`
inside each package by CI as well — checked-in `bin/` is not committed.
