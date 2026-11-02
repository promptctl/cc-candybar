# Design: isolated daemons and a structured wire

The Frame is built. The rest is design. Each area says where it stands.

| Read | For |
|---|---|
| [goals.md](goals.md) | Brandon's goals, constraints and rulings, verbatim. Everything answers to this |
| [architecture.md](architecture.md) | Gather, renderers, and how they fit |
| [contracts.md](contracts.md) | Every shape that crosses between parts |

## Areas

Each has the same sections: Owns, Why, Design, To probe, Done when, plus Evidence or To survey where it has them. Anything not listed under Evidence has not been run. An area needs [contracts.md](contracts.md), not the other areas.

| Area | Owns | Needs first |
|---|---|---|
| [frame](areas/frame.md) | Draw's output, encoders. Built | Nothing |
| [events](areas/events.md) | The queue, pure clicks, Apply | Nothing |
| [isolation](areas/isolation.md) | Renderer values, relative paths | Nothing |
| [gather](areas/gather.md) | The Gather process, total facts, sources | Nothing to start; proving it needs lifetime's connection |
| [clicks](areas/clicks.md) | Names, the minter, the handler, routing | Gather's connection for routing; the minter needs nothing |
| [lifetime](areas/lifetime.md) | Starting, supervising, versioning, memory | Gather's connection |
| [tmux events](areas/tmux-events.md) | The control connection, the hidden bar pane, the off-screen rate | Nothing |
| [browser surface](browser-surface.md) | The browser as a surface: transport, listener, security, the page | The Frame |

## Reference

- [inventory/](inventory/): four read-only surveys of the code at commit `10f26ceb`. The daemon has been split up since, so check a location before relying on it.
- [probes/](probes/README.md): the scripts behind the evidence.

## Working on this

**Rely heavily on subagents.** `src/daemon/` is large, and a session that reads this code directly runs out of context. Delegate reading, surveys and implementation, and keep the main session for decisions.

A subagent sees only its prompt, so put every requirement in it, quoted from [goals.md](goals.md) where the wording matters, with its area doc and an acceptance check. Read what it produced, not its summary. `Explore` agents can't write files, so have them return findings as their final message.

Load `laws:code` first. The laws govern this work.

## Awaiting a decision

Removal candidates: `env` variables ([gather](areas/gather.md)), `load-config` ([isolation](areas/isolation.md)), and direct verb URLs ([clicks](areas/clicks.md)).
