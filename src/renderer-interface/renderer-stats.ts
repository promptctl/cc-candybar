// The renderer's portion of the daemon's stats reply: what the renderer
// reports of itself, as the host receives it and the stats client prints it.
//
// [LAW:one-way-deps] It is a module of its own below both sides: the renderer
// interface carries the reply's type, and the host's stats snapshot embeds the
// same portion, so neither imports the other for it.

// [LAW:nothing-unseen] The states renders are drawing with now, and those
// retired but not yet reclaimed because one still is (`daemon-stats`):
// `retired` climbing while `size` holds is a render that never returned.
export interface RenderCacheStats {
  readonly size: number;
  readonly held: number;
  readonly retired: number;
  // Distinct compiles the cache holds — below `size` exactly when entries
  // share them.
  readonly compiles: number;
  // Sessions' views served now: one per session at most.
  readonly views: number;
  // Sessions an open feed pins (`pin`).
  readonly pinned: number;
  // Views retired but not yet disposed because a render still holds one: as
  // `retired` is for states, climbing while `views` holds is a render that
  // never returned.
  readonly retiredViews: number;
  // The transitions in flight on the views' surfaces, each a rich-js effect
  // holding its settled shares: climbing while `views` holds is a surface
  // whose passages never end.
  readonly passages: number;
  // What the entries the map serves are charged against the budget.
  readonly accountedBytes: number;
  readonly budgetBytes: number;
}

export interface MenuIdleStats {
  readonly sessions: number;
  readonly armed: number;
}

export interface RendererStats {
  readonly renderCache: RenderCacheStats;
  readonly effectCache: {
    readonly sessions: number;
    readonly effects: number;
  };
  // Sessions whose idle clock the renderer keeps, and those whose menus it
  // will close when their idle period runs out (src/renderer/menu-idle.ts).
  readonly menuIdle: MenuIdleStats;
  // [LAW:nothing-unseen] Renderer work awaiting config, an effect result,
  // or a future tick. Growth without new inputs signals a stuck lifetime.
  readonly rendererTurns: {
    readonly parked: number;
    readonly presents: number;
    readonly deferrals: number;
  };
  // The per-session click store: how many sessions it holds, how many
  // derivations are subscribed to it, and its revision — how many changes it
  // has taken. Observers climbing while renderCache holds steady is a
  // disposed config's store still held; the revision climbing while nobody
  // clicks is something writing session state on every render.
  readonly sessionState: {
    readonly sessions: number;
    readonly observers: number;
    readonly revision: number;
  };
  readonly framesDrawn: number;
}
