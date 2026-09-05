// [LAW:verifiable-goals] bdi.4 acceptance: the duration/time-remaining
// formatters, migrated from JS FuncMap funcs into DEFAULT_DSL_CONFIG.helpers,
// render byte-identically to the formatters they retired.
//
// [LAW:behavior-not-structure] The oracles (formatTimeSince / formatDuration /
// formatResponseTime / formatLongTimeRemaining) were DELETED in this change —
// their outputs are pinned here as literals so the test asserts the helper's
// contract without depending on the retired code. Each literal is the exact
// string the JS twin produced for that input (its formula recorded in the
// table comment).
//
// minutesUntilReset stays a numeric FUNC (it returns a value consumed in
// comparisons and as a helper arg — a `{{ template }}` helper cannot return a
// value). bdi.4 migrates it off the hidden Date.now() onto the injected clock
// seam; a FROZEN clock here makes the minute arithmetic deterministic and pins
// the past-expiry clamp to 0.
//
// These exercise the PRODUCTION helpers: the test config is merged onto
// DEFAULT_DSL_CONFIG, so the `{{ template "name" }}` calls resolve the same
// helper bodies the shipped statusline uses — not a test-local copy.

import { SessionState } from "../src/daemon/session-state";
import { getThemePalette } from "@promptctl/rich-js";

import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};
const BASE_PALETTE = getThemePalette("textual-dark"!);

// A whole-second-aligned frozen instant: clock().getTime() === NOW_MS exactly,
// so minutesUntilReset's `epoch*1000 - now` arithmetic has no sub-second slack.
const NOW_MS = Date.parse("2026-06-04T00:00:00.000Z");
const NOW_SEC = NOW_MS / 1000;
const FROZEN_CLOCK = () => new Date(NOW_MS);

const VARS = `{
  s: { kind: "input", path: "s", type: "number", default: 0 },
  m: { kind: "input", path: "m", type: "number", default: 0 },
  e: { kind: "input", path: "e", type: "number", default: 0 },
}`;

// Render one segment whose template is `call`, merged onto DEFAULT_DSL_CONFIG so
// the production helpers are in scope, against the frozen clock. Returns the
// plain (ANSI/OSC-8-stripped) text the segment produced.
function render(call: string, payload: Record<string, number>): string {
  const source = `{
    variables: ${VARS},
    segments: { probe: { template: ${JSON.stringify(call)} } },
    root: "probe",
  }`;
  const raw = parseDslConfig("<test>", source);
  const config = validateConfig(
    mergeWithDefault(raw, DEFAULT_DSL_CONFIG),
    "<test>",
    source,
  ) as ValidatedConfig;
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(config, registry, {
    cwd: "/tmp",
    clock: FROZEN_CLOCK,
  });
  const out = renderDsl(
    config,
    compiled,
    store,
    registry,
    payload,
    BASE_PALETTE,
    OPTS,
  );
  return out
    .replace(/\x1b\]8;[^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

describe("bdi.4 — formatTimeSince helper (byte-parity with retired JS)", () => {
  // <60 → "Ns" verbatim; then floor(s/60)m, floor(s/3600)h, floor(s/86400)d,
  // floor(s/604800)w. Boundaries 60/3600/86400/604800 roll to the next unit.
  test.each<[number, string]>([
    [0, "0s"],
    [30, "30s"],
    [59, "59s"],
    [60, "1m"],
    [90, "1m"],
    [3599, "59m"],
    [3600, "1h"],
    [7200, "2h"],
    [86399, "23h"],
    [86400, "1d"],
    [604799, "6d"],
    [604800, "1w"],
    [1209600, "2w"],
  ])("formatTimeSince(%p) === %p", (s, want) => {
    expect(render('[{{ template "formatTimeSince" .s }}]', { s })).toContain(
      `[${want}]`,
    );
  });
});

describe("bdi.4 — formatDuration helper", () => {
  // <60 toFixed(0)+s; <3600 (/60).toFixed(0)+m; <86400 (/3600).toFixed(1)+h;
  // else (/86400).toFixed(1)+d. toFixed rounds (90→1.5min→"2m").
  test.each<[number, string]>([
    [0, "0s"],
    [30, "30s"],
    [59, "59s"],
    [60, "1m"],
    [90, "2m"],
    [3599, "60m"],
    [3600, "1.0h"],
    [7200, "2.0h"],
    [86399, "24.0h"],
    [86400, "1.0d"],
    [172800, "2.0d"],
  ])("formatDuration(%p) === %p", (s, want) => {
    expect(render('[{{ template "formatDuration" .s }}]', { s })).toContain(
      `[${want}]`,
    );
  });
});

describe("bdi.4 — formatResponseTime helper", () => {
  // <60 toFixed(1)+s; else (/60).toFixed(1)+m.
  test.each<[number, string]>([
    [0, "0.0s"],
    [5.6, "5.6s"],
    [12.3, "12.3s"],
    [59.9, "59.9s"],
    [60, "1.0m"],
    [120, "2.0m"],
    [600, "10.0m"],
  ])("formatResponseTime(%p) === %p", (s, want) => {
    expect(render('[{{ template "formatResponseTime" .s }}]', { s })).toContain(
      `[${want}]`,
    );
  });
});

describe("bdi.4 — formatLongTimeRemaining helper (input = whole minutes)", () => {
  // >=1440 → "Nd"/"Nd Nh" (hours appended only when >0); >=60 → "Nh"/"Nh Nm";
  // else "Nm". Boundaries 60/1440 and the zero-lower-unit collapse covered.
  test.each<[number, string]>([
    [0, "0m"],
    [30, "30m"],
    [59, "59m"],
    [60, "1h"],
    [90, "1h 30m"],
    [120, "2h"],
    [180, "3h"],
    [1439, "23h 59m"],
    [1440, "1d"],
    [1500, "1d 1h"],
    [2880, "2d"],
    [2940, "2d 1h"],
    [4320, "3d"],
  ])("formatLongTimeRemaining(%p) === %p", (m, want) => {
    expect(
      render('[{{ template "formatLongTimeRemaining" .m }}]', { m }),
    ).toContain(`[${want}]`);
  });
});

describe("bdi.4 — minutesUntilReset func against a frozen clock", () => {
  // ceil(max(0, epoch*1000 - now)/60000). Any time left reads as at least 1;
  // a whole minute reads exactly; the instant itself and the past clamp to 0.
  test.each<[number, string]>([
    [NOW_SEC, "0"],
    [NOW_SEC + 1, "1"],
    [NOW_SEC + 59, "1"],
    [NOW_SEC + 60, "1"],
    [NOW_SEC + 61, "2"],
    [NOW_SEC + 90 * 60, "90"],
    [NOW_SEC - 3600, "0"],
    [NOW_SEC - 1, "0"],
  ])("minutesUntilReset(%p) === %p", (e, want) => {
    expect(render("[{{ minutesUntilReset .e }}]", { e })).toContain(`[${want}]`);
  });

  // The block/weekly composition: minutesUntilReset feeds formatLongTimeRemaining.
  // e = now + 2940 minutes → 2940 → "2d 1h".
  test("composes formatLongTimeRemaining (minutesUntilReset .e)", () => {
    expect(
      render(
        '[{{ template "formatLongTimeRemaining" (minutesUntilReset .e) }}]',
        { e: NOW_SEC + 2940 * 60 },
      ),
    ).toContain("[2d 1h]");
  });
});
