import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestedConfigTarget } from "../../src/config-hint";
import {
  droppedPluginNotice,
  type ConfigLayer,
} from "../../src/config/dsl-loader";
import { configQuery } from "../../src/config/loader/chain-places";
import { repoQuestionLines } from "../../src/config/loader/repo-gate";
import {
  discover,
  readShared,
} from "../../src/daemon/config-discovery/discover";
import { locations, stateDir } from "../../src/daemon/paths";
import type { World } from "../../src/host";
import { textOf, type Frame } from "../../src/render/frame";
import { instantOf } from "../../src/utils/instant";
import { explicitConfigPath } from "../../src/utils/user-path";
import { WORLD } from "./host";
import { prepareSnapshot, renderEffective } from "../../scripts/lib/draw-fixtures/prepared-config";

// [LAW:types-are-the-program] A draw supplies its frame or the diagnostic that prevented it.
export type ConfigDraw = {
  readonly layers: readonly ConfigLayer[];
  readonly warnings: readonly string[];
} & (
  | { readonly kind: "clean"; readonly rendered: Frame }
  | { readonly kind: "fatal"; readonly message: string }
);

// [LAW:verifiable-goals] When a test names a file, the frame must exercise that
// file. The live daemon can render the bundled default while a file is absent.
export function discoverFixture(
  world: World,
  file: string | undefined,
  cwd: string,
) {
  const target = requestedConfigTarget(
    explicitConfigPath(cwd, file, world.host.home),
    undefined,
  );
  const { snapshot } = discover(
    { ...configQuery(cwd, target), cwd },
    readShared({
      locations: locations(world.host),
      stateDir: stateDir(world.host),
    }),
  );
  const layers = snapshot.chain.flatMap(({ content, role, path }) =>
    content.kind === "text" ? [{ role, path }] : [],
  );
  if (
    target.path !== undefined &&
    !layers.some((layer) => layer.path === target.path)
  ) {
    const layer = snapshot.chain.find(
      (candidate) => candidate.path === target.path,
    );
    const reason =
      layer?.content.kind === "unreadable"
        ? layer.content.error
        : "file was not loaded";
    throw new Error(`config fixture ${target.path}: ${reason}`);
  }
  return { snapshot, layers, warnings: [...repoQuestionLines(snapshot.repo)] };
}

// Draw the preset a fresh session selects.
export async function renderConfig(
  world: World,
  file?: string,
  cwd: string = process.cwd(),
): Promise<ConfigDraw> {
  const { snapshot, layers, warnings } = discoverFixture(world, file, cwd);
  try {
    using prepared = prepareSnapshot(world, snapshot, cwd, warnings);
    const effective = prepared.effective();
    const { rendered, failures, pending } = await renderEffective(
      prepared,
      effective,
      200,
      instantOf(new Date(world.clock.now())),
    );
    warnings.push(...pending.map((name) => `source still pending: ${name}`));
    const errors = [...failures, ...prepared.droppedPlugins.map(droppedPluginNotice)];
    if (errors.length > 0)
      return { kind: "fatal", message: errors.join("\n"), warnings, layers };
    return { kind: "clean", rendered, layers, warnings };
  } catch (error) {
    return {
      kind: "fatal",
      message: error instanceof Error ? error.message : String(error),
      warnings,
      layers,
    };
  }
}

export async function withTempConfig<T>(
  text: string,
  fn: (configPath: string) => Promise<T> | T,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-render-config-"));
  const configPath = path.join(dir, ".cc-candybar.json5");
  fs.writeFileSync(configPath, text);
  try {
    return await fn(configPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function expectClean(
  label: string,
  outcome: ConfigDraw,
): Extract<ConfigDraw, { kind: "clean" }> {
  if (outcome.kind !== "clean") {
    throw new Error(`${label}: ${outcome.message}`);
  }
  expect(textOf(outcome.rendered).length).toBeGreaterThan(0);
  return outcome;
}

// The clean outcome of a config given as text.
export function checkText(
  label: string,
  text: string,
): Promise<Extract<ConfigDraw, { kind: "clean" }>> {
  return withTempConfig(text, async (p) =>
    expectClean(label, await renderConfig(WORLD, p)),
  );
}
