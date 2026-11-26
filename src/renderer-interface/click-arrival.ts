import type { ActsOn } from "../daemon/foundations/protocol";

// [LAW:types-are-the-program] Who delivered a link to the daemon: the URL
// handler app, forwarding it raw in a frame of the version it spells, or
// `cc-candybar url-handle`, which splits the verb itself — run by hand, or by
// the retired AppleScript applet an old install left registered for the scheme.
// A forwarder says where the click's copy and open act (`actsOn` in its
// frame): its own machine, the desktop, or the daemon's.
export type Delivery =
  | {
      readonly kind: "forwarder";
      readonly urlV: number;
      readonly actsOn: ActsOn;
    }
  | { readonly kind: "cli" };

// How a click reached the renderer: a link the terminal drew, with who
// delivered it; a range of the tmux status line, which a binding tmux ran
// delivered (no code writes that binding now, so nothing produces this arm); or
// a local command hosting its own bar.
export type ClickArrival =
  | { readonly via: "link"; readonly delivery: Delivery }
  | { readonly via: "tmux-status" }
  | { readonly via: "command" };

// [LAW:single-enforcer] Where a click's copy and open act, read from how it was
// delivered: the one place the frame's say on it is kept. Every other way a
// click arrives acts on the daemon's machine.
export const deliveredActsOn = (delivery: Delivery): ActsOn =>
  delivery.kind === "forwarder" ? delivery.actsOn : "daemon";
