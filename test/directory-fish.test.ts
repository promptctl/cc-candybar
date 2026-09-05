// [LAW:verifiable-goals] brandon-directory-781 makes fish-style path
// abbreviation the DEFAULT directory rendering. This pins the exact composition
// rule the ticket asked us to define: the directory template COLLAPSES first
// (~-relative → project-relative → absolute), then ABBREVIATES the survivor
// (every segment but the leaf → its leading char). Rendered through the real
// spine (registerDslConfig + renderDsl), the same two functions the daemon and
// demo call — not a synthetic in-process transform.

import { RAW_DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { getThemePalette } from "@promptctl/rich-js";
import { abbreviatePath } from "../src/utils/formatters";
import { EDIT_NS } from "../src/config/loader/edit-mode";

// Reparse the AUTHORED literal (pre-synthesis) — see
// test/default-dsl-config.test.ts for why this must be the raw form, not the
// already-synthesized DEFAULT_DSL_CONFIG.
const SERIALIZED = JSON.stringify(RAW_DEFAULT_DSL_CONFIG, null, 2);

// Narrow the root to just the directory segment so the rendered line is exactly
// that segment's text. Plain style + ascii + padding 0 strips all chrome, so
// after removing ANSI/OSC-8 escapes what remains IS the directory string.
const dirOnlyRoot = {
  rows: {
    main: {
      kind: "container" as const,
      direction: "horizontal" as const,
      children: [{ kind: "segment" as const, name: "directory" }],
    },
  },
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

// [LAW:locality-or-seam] `toolbar` references `edit.toggle`
// (brandon-layout-edit-2gc.4), so `synthesizeEditChrome` (inside
// `parseAndValidate`, before any call site here narrows the layout) has
// already baked a spliced copy of the full root into `presets.default.root`
// — `registerDslConfig`'s per-preset compile prefers that over a plain
// top-level `root:` override (`presetRoot`/`presets.ts`). Every narrowing
// below must also reset `presets` and drop the synthesized `edit.*` entries
// (`directory`'s own template never references `edit.toggle`, so none of
// that machinery is needed in this file) or the baked-in full root shadows
// the narrowed one.
const dropEditNs = <V>(rec: Readonly<Record<string, V>>) =>
  Object.fromEntries(
    Object.entries(rec).filter(([name]) => !name.startsWith(EDIT_NS)),
  );

function renderDir(paths: {
  home: string;
  project_dir: string;
  current_dir: string;
}): string {
  const base = parseAndValidate("<default>", SERIALIZED);
  const parsed = {
    ...base,
    presets: {},
    variables: dropEditNs(base.variables),
    actions: dropEditNs(base.actions),
    segments: dropEditNs(base.segments),
    root: dirOnlyRoot,
  };
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(parsed, registry, {
      cwd: paths.current_dir,
    });
    const basePalette = getThemePalette("textual-dark"!);
    const payload = {
      hook_event_name: "Status",
      session_id: "dir-fish-test-0000-0000-000000000000",
      cwd: paths.current_dir,
      home: paths.home,
      model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
      workspace: {
        current_dir: paths.current_dir,
        project_dir: paths.project_dir,
        added_dirs: [],
      },
    };
    return renderDsl(parsed, compiled, store, registry, payload, basePalette, {
      style: "plain",
      colorCompatibility: "none",
      wrap: true,
      padding: 0,
      charset: "ascii",
      width: Number.POSITIVE_INFINITY,
    })
      .replace(ANSI, "")
      .trim();
  } finally {
    registry.dispose();
  }
}

describe("abbreviatePath (pure helper)", () => {
  test.each([
    ["~/code/cc-candybar", "~/c/cc-candybar"],
    ["~", "~"],
    ["src/deep/leaf", "s/d/leaf"],
    ["my-app", "my-app"],
    ["/var/log/nginx", "/v/l/nginx"], // leading slash preserved
    ["~/.config/nvim", "~/.c/nvim"], // dotfile keeps its dot
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(abbreviatePath(input)).toBe(expected);
  });
});

describe("default directory segment renders fish-abbreviated", () => {
  test("under home: ~-collapse then abbreviate ancestors, keep leaf", () => {
    expect(
      renderDir({
        home: "/Users/bmf",
        project_dir: "/Users/bmf/code/cc-candybar",
        current_dir: "/Users/bmf/code/cc-candybar",
      }),
    ).toBe("~/c/cc-candybar");
  });

  test("home === cwd collapses to a bare ~", () => {
    expect(
      renderDir({
        home: "/Users/bmf",
        project_dir: "/Users/bmf",
        current_dir: "/Users/bmf",
      }),
    ).toBe("~");
  });

  test("not under home, deep under project: project-relative then abbreviate", () => {
    expect(
      renderDir({
        home: "/root",
        project_dir: "/srv/app",
        current_dir: "/srv/app/src/deep/leaf",
      }),
    ).toBe("s/d/leaf");
  });

  test("project root renders its basename (single segment, unabbreviated)", () => {
    expect(
      renderDir({
        home: "/root",
        project_dir: "/srv/my-app",
        current_dir: "/srv/my-app",
      }),
    ).toBe("my-app");
  });

  test("outside home and project: absolute path abbreviated, leaf full", () => {
    expect(
      renderDir({
        home: "/root",
        project_dir: "/other",
        current_dir: "/var/log/nginx",
      }),
    ).toBe("/v/l/nginx");
  });
});

describe("configurability seam: user template override restores full path", () => {
  // [LAW:no-mode-explosion] There is no `style` enum — the full path is the
  // existing merge-by-name seam: a user config redefines segments.directory
  // and it wins per-name over the bundled default. Here we render that override
  // through the same spine and confirm the full, unabbreviated path comes back.
  test("overriding segments.directory.template yields the unabbreviated path", () => {
    const parsed = parseAndValidate("<default>", SERIALIZED);
    const overridden = {
      ...parsed,
      root: dirOnlyRoot,
      presets: {},
      variables: dropEditNs(parsed.variables),
      actions: dropEditNs(parsed.actions),
      segments: dropEditNs({
        ...parsed.segments,
        directory: { ...parsed.segments.directory, template: "{{ .current_dir }}" },
      }),
    };
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, new SessionState());
    try {
      const compiled = registerDslConfig(overridden, registry, {
        cwd: "/Users/bmf/code/cc-candybar",
      });
      const basePalette = getThemePalette("textual-dark"!);
      const line = renderDsl(
        overridden,
        compiled,
        store,
        registry,
        {
          hook_event_name: "Status",
          session_id: "dir-fish-override-0000-0000-000000000000",
          cwd: "/Users/bmf/code/cc-candybar",
          home: "/Users/bmf",
          model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
          workspace: {
            current_dir: "/Users/bmf/code/cc-candybar",
            project_dir: "/Users/bmf/code/cc-candybar",
            added_dirs: [],
          },
        },
        basePalette,
        {
          style: "plain",
          colorCompatibility: "none",
          wrap: true,
          padding: 0,
          charset: "ascii",
          width: Number.POSITIVE_INFINITY,
        },
      )
        .replace(ANSI, "")
        .trim();
      expect(line).toBe("/Users/bmf/code/cc-candybar");
    } finally {
      registry.dispose();
    }
  });
});
