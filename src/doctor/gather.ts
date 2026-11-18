// The doctor's facts as a run judges them: what the renderer asks the host to
// read of the machine (`DoctorAsk`), what the host's reading carries
// (`DoctorReading`, src/doctor/read.ts), and the facts the checks fold, made
// of that reading, the config load the ask was made for, and the doctor's
// stores. Shared and pure, so the renderer's doctor and `cc-candybar doctor`
// compose one set of facts the same way.
//
// [LAW:effects-at-boundaries] Nothing here reads the machine: the host reads
// it for an ask (src/daemon/cache/doctor.ts), in the daemon and in
// `cc-candybar doctor` alike.

import { projectLocalSettingsFile } from "../claude-settings.js";
import { dataNeeds, type DataNeeds } from "./data-needs.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import type { Change } from "../config/config-changes.js";
import type {
  Asked,
  ConfigFacts,
  DaemonFacts,
  DoctorFacts,
  Fix,
  Held,
  InstallFacts,
  PostMortemsRead,
  SettingsChain,
} from "./checks.js";
import { privateGlyphsIn, stripPrivateGlyphs } from "../render/strip.js";
import type { ConfigTarget } from "../config-hint.js";
import { handlerProvenBy, type ClickArrival } from "./sightings.js";
import type { StoresRead } from "../daemon/foundations/stats-snapshot.js";
import type { DoctorDocuments, ConfigLoad } from "./ports.js";
import {
  isJsonObject,
  type JsonObject,
  type SettingsSource,
} from "../claude-settings.js";
import { laterIdentity } from "../daemon/foundations/memory-limit.js";
import type { JsonValue } from "../var-system/types.js";

// Every fs read here throws its own errno text; the facts carry it instead.
export function asked<T>(read: () => T): Asked<T> {
  try {
    return { kind: "ok", value: read() };
  } catch (e) {
    return {
      kind: "failed",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export const readStores = (stores: DoctorDocuments): StoresRead => ({
  marks: stores.marks.read(),
  clicked: stores.clicked.read(),
  postMortemsRead: stores.postMortemsRead.read(),
});

// [LAW:types-are-the-program] What a run asks of the machine, decided by the
// config it judges: the glyphs to ask the terminal's font about (none, "",
// asks nothing) and the outside data a placed segment needs. `arrival` is how
// the click that asked it came, which is what the run knows of the URL
// handler. `run` names the run, so a new run is a new ask, read again.
export interface DoctorAsk {
  readonly run: number;
  readonly glyphs: string;
  readonly needs: DataNeeds;
  readonly arrival: ClickArrival;
}

// Where the session runs: the checkout a forge is asked about, and the
// project whose settings files are read — and so may be written by a fix.
// [LAW:single-enforcer] The host takes it from the session's own request,
// never from the ask, so no renderer names the files a fix may write.
export interface DoctorOrigin {
  readonly cwd: string;
  readonly projectDir: string;
}

// What the host reads for an ask: every fact but the config's and the
// stores', which are the renderer's.
export type MachineFacts = Omit<
  DoctorFacts,
  "config" | "marks" | "clicked" | "install" | "daemon"
> & { readonly daemon: Omit<DaemonFacts, "read"> };

// [LAW:types-are-the-program] One run's reading, as a world state carries it:
// the run it answers, and the machine as the host read it with the install the
// clients that drew the session's bars ran — or why it was not read. A
// failure names its run too, so one left from an earlier run is never taken
// for the run after it (src/daemon/readings.ts).
export type DoctorReading = { readonly run: number } & (
  | {
      readonly kind: "read";
      readonly machine: MachineFacts;
      readonly install: Held<InstallFacts>;
    }
  | { readonly kind: "failed"; readonly reason: string }
);

export type DoctorRead = Extract<DoctorReading, { kind: "read" }>;

// [LAW:one-source-of-truth] What a run asks, from the config it judges: the
// render's own resolution, so the doctor and the bar cannot disagree about
// which preset is placed or which joiner draws it. The joiner's glyphs, then
// every one the config's own text writes — a Nerd icon in a template or a
// menu glyph is drawn as surely as a cap.
export function doctorAsk(
  run: number,
  load: ConfigLoad,
  sessionPick: (key: string) => string | null,
  arrival: ClickArrival,
): DoctorAsk {
  const globals = resolveEffectiveGlobals(
    load.config,
    sessionPick,
    () => false,
  );
  return {
    run,
    glyphs: [
      ...new Set([
        ...stripPrivateGlyphs(globals),
        ...privateGlyphsIn(JSON.stringify(load.config)),
      ]),
    ].join(""),
    needs: dataNeeds(load.config, globals.preset),
    arrival,
  };
}

// [LAW:dataflow-not-control-flow] The load's two arms become ConfigFacts'
// two.
function configFacts(load: ConfigLoad, target: ConfigTarget): ConfigFacts {
  const base = {
    layers: load.layers,
    target,
    warnings: load.warning === null ? [] : load.warning.split("\n"),
  };
  return load.error !== null
    ? { ...base, kind: "failed", error: load.error }
    : {
        ...base,
        kind: "loaded",
        unused: load.unused,
      };
}

// [LAW:single-enforcer] The one composition of a run's facts: the machine as
// read, the load the ask was made for, the stores as they stand, and how the
// click being judged arrived — one that came by a link proves the URL
// handler, whatever the reading found for the click that asked it.
export function doctorFacts(
  { machine, install }: DoctorRead,
  load: ConfigLoad,
  target: ConfigTarget,
  stores: StoresRead,
  arrival: ClickArrival,
): DoctorFacts {
  return {
    ...machine,
    urlHandler: handlerProvenBy(arrival, () => machine.urlHandler),
    config: configFacts(load, target),
    marks: stores.marks,
    clicked: stores.clicked,
    daemon: { ...machine.daemon, read: stores.postMortemsRead },
    install,
  };
}

// [LAW:one-source-of-truth] Each settings chain a run read: its own, then
// every other one a bar it judges reads at.
const chainsOf = (
  settings: DoctorFacts["claudeSettings"],
): readonly SettingsChain[] => [settings.origin, ...settings.elsewhere];

// [LAW:single-enforcer] The settings files a run's fix may write: each chain
// it read, its user file and its project-local file — the scopes
// `WritableSettings` admits. The host's interpreter refuses a write to any
// other file (src/daemon/effect-interpreter.ts).
export const writableSettingsFiles = ({
  machine,
}: DoctorRead): readonly string[] =>
  chainsOf(machine.claudeSettings).flatMap(({ at }) => [
    at.userFile,
    projectLocalSettingsFile(at.projectDir),
  ]);

// Every settings file the run read, from each chain that read.
export const readSources = (
  settings: DoctorFacts["claudeSettings"],
): readonly SettingsSource[] =>
  chainsOf(settings).flatMap(({ sources }) =>
    sources.kind === "ok" ? sources.value : [],
  );

// The post-mortems read through a breach. Filing only ever moves forward: a
// fix computed before another run filed a newer breach leaves that one filed.
export const readThrough =
  (through: string) =>
  (current: PostMortemsRead): PostMortemsRead =>
    current.through === null || laterIdentity(through, current.through)
      ? { through }
      : current;

// [LAW:single-enforcer] A `claude-settings` fix as the change it is, guarded
// by what the run read of the file it writes (docs/design/host-and-renderer.md
// §7, A-3): the host lands it only while that setting is as read, so a fix
// lands only on the settings it diagnosed. A value read is replaced; a key the
// file lacks is inserted with the branch it hangs from, under the deepest
// object that holds it — the whole document when the run read no such file.
// Text in strict JSON, the dialect Claude Code parses its settings in.
export function settingChange(
  fix: Extract<Fix, { kind: "claude-settings" }>,
  sources: readonly SettingsSource[],
): Change {
  const file = sources.find((s) => s.path === fix.file.path);
  return file === undefined
    ? {
        op: "insert",
        at: [],
        text: `${branch(fix.path, fix.value)}\n`,
        precedes: null,
      }
    : changeUnder(file.settings, [], fix.path, fix.value);
}

// The keys `path` names, under `parent` at `at`: the first one the parent
// lacks is inserted with the rest of the branch, and the setting itself, or a
// value where the branch needs an object, is replaced whole, as read.
function changeUnder(
  parent: JsonObject,
  at: readonly string[],
  [key, ...rest]: readonly [string, ...string[]],
  value: string | number,
): Change {
  const here = [...at, key];
  const read = parent[key];
  if (read === undefined)
    return {
      op: "insert",
      at: here,
      text: branch(rest, value),
      precedes: null,
    };
  const [next, ...more] = rest;
  return next === undefined || !isJsonObject(read)
    ? {
        op: "replace",
        at: here,
        text: branch(rest, value),
        read: { kind: "value", text: JSON.stringify(read) },
      }
    : changeUnder(read, here, [next, ...more], value);
}

// `value` under `keys`, as JSON text laid out as the editor lays out a branch
// it adds: two spaces a level, which the splice indents to where it lands.
const branch = (keys: readonly string[], value: string | number): string =>
  JSON.stringify(
    keys.reduceRight<JsonValue>((inner, key) => ({ [key]: inner }), value),
    null,
    2,
  );
