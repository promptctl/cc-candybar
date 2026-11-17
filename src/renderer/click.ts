// The renderer's click turn: what a click means is the verb its link names,
// acted on in this turn, so the turn's output reads the subscriptions as they
// stand once the act has landed (its commit).

import { BadVerbArgs } from "../daemon/foundations/verb-error.js";
import type { Effect, Event } from "../renderer-interface/interface.js";
import type { MainRendererParts } from "./verbs/port.js";

type ClickEvent = Extract<Event, { kind: "click" }>;

// [LAW:no-silent-failure] A verb the table does not have is the click's bad
// request; whatever the act throws is the turn's throw, which the renderer
// classifies as the turn's failure and the host turns into the click's reply
// by its kind.
export function clickTurn(
  { verbs, renderCache }: Pick<MainRendererParts, "verbs" | "renderCache">,
  { verb, value, arrival, latest, config }: ClickEvent,
  // Where the click's config changes go, kept by the turn even when the
  // handler throws.
  effects: Effect[],
): void {
  const handler = verbs.handler(verb);
  if (handler === undefined)
    throw new BadVerbArgs(`unknown click verb: ${verb}`);
  // [LAW:dataflow-not-control-flow] The config the host discovered at the
  // click is the session's before its verb reads it; the entry reloads only
  // when it moved.
  if (config !== null) {
    const { projectDir, cwd, target } = config.origin;
    renderCache.configure(
      config.session,
      projectDir,
      cwd,
      target.path,
      config.snapshot,
    );
  }
  handler(value, { arrival, latest, effects });
}
