# Contracts

Status: design, except the Frame, which is built. These are the shapes that cross between parts. Until a shape is built it's defined here, and an area that needs to change one changes it here. Once built, the code defines it.

## Frame

Built. `Frame`, `Row`, `Run` and `WireFrame` are in `src/render/frame.ts`.

A render request names the encoding it wants. `ansi` is the default, so the Rust client sends nothing new and reads `output` as it does today.

## SessionFacts

Gather to renderer, one plain JSON document per session, pushed when it changes.

```ts
interface SessionFacts {
  hook: ClaudeHookData;          // the latest forwarded request's
  builtins: BuiltinFacts;        // total: session, metrics, activity, context, git, …
  sources: Record<SourceId, SourceReading>;
  todaySums: DaySums | Pending;  // the renderer picks the day at its instant
  diagnostics: FactsDiagnostic[];// file events, lifeline
}
interface SourceReading {
  reading: Reading;              // ok | pending | failed
  failedAt?: "read" | "parse";
  at: Instant;
  fault?: string;                // a watch the OS refused
  newKeyOut: boolean;            // a run for a moved key is in flight
}
interface FactsDiagnostic { about: string; level: Level; text: string; copy: string }
```

The payload a template reads is composed in the renderer by `payloadOf`, from these facts and the renderer's own state. Settings, picks, history depth and config facts are the renderer's and never cross.

`PENDING` is compared by identity, so a JSON copy stops meaning pending. The parse at the receiving edge restores it.

## Renderer to Gather

One connection, dialled by the renderer and held. Its close is the fact that the renderer has gone.

```ts
type RendererMessage =
  | { kind: "attach"; name: string; v: number }
  | { kind: "follow"; session: SessionId }
  | { kind: "hook"; hook: ClaudeHookData; hints: ClientHints }
  | { kind: "declare"; session: SessionId; layers: ConfigLayer[]; sources: SourceSpec[] }
  | { kind: "key"; source: SourceId; keyValueHash: string }
  | { kind: "supersede"; storage: StorageKey; session: SessionId };
```

A second `attach` under a live name is refused loudly.

## Gather to renderer

```ts
type GatherMessage =
  | { kind: "attached"; attachId: string }
  | { kind: "facts"; session: SessionId; facts: SessionFacts }
  | { kind: "tmux"; socket: string; view: TmuxView }
  | { kind: "click"; verb: string; value: string; arrival: ClickArrival };

type TmuxView =
  | { kind: "known"; shown: PaneId[]; sessionOf: Record<PaneId, TmuxSessionId>; shownBy: Record<TmuxSessionId, PaneId> }
  | { kind: "unknown"; reason: string };     // every pane counts as shown
```

One view per tmux server, not per session, because it comes from one connection. See [areas/tmux-events.md](areas/tmux-events.md).

Sent in order on one connection, so a click is in sequence with the facts around it.

## Links

Every drawn `cc-candybar://` link has one form, and one minter in the renderer builds it:

```
cc-candybar://to/<renderer-name>/<verb>/<value>
```

The name is stable across that renderer's restarts and never varies per frame, because feeds dedupe on bytes and kept template parts would go stale. It isn't signed: `SignedFields` covers session, action, declaration and evaluation, so a changed name can't alter what runs.

## tmux status ranges

A tmux status line can't hold a minted link, so each linked run carries a range id of at most 15 bytes:

```
ccb <attach id: 5> <link id: 7>
```

Both ids come from counters and are never reused. A digest can collide, and a collision would run the wrong link silently. The attach id is new on every `attach`, including a restarted renderer's, so a line left by an old process can't match new links. The renderer holds the id-to-link table, and one URL keeps its id while it stays drawn. A renderer out of link ids attaches again. Gather out of attach ids refuses the `attach`.

## Events

The queue's entries are plain data. Every source of change produces one, and Apply is their only consumer.

```ts
type Event =
  | { kind: "click"; verb: string; value: string; arrival: ClickArrival }
  | { kind: "idle-close"; session: SessionId }
  | { kind: "config-changed"; path: RelativePath }
  | { kind: "surface-requested"; session: SessionId; surface: Surface; on: boolean };
```

The list grows with what [areas/events.md](areas/events.md) finds. A click's verbs stay data inside the event.

## Renderer values

Everything that distinguishes one renderer from another:

| Value | Set by |
|---|---|
| `name` | Derived from its socket, or stated at start |
| `socket` | `CC_CANDYBAR_SOCKET`, else the default |
| `stateRoot` | `XDG_STATE_HOME` |
| `configHome` | `XDG_CONFIG_HOME` |
| Bundle | The statusline command's path |
| Gather's address | One fixed per-user socket, beside the default socket |

Clients keep reaching the default socket, which belongs to the main renderer. Gather takes a new path.
