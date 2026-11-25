// [LAW:types-are-the-program] Who delivered a link to the daemon: the URL
// handler app, forwarding it raw in a frame of the version it spells, or
// `cc-candybar url-handle`, which splits the verb itself — run by hand, or by
// the retired AppleScript applet an old install left registered for the scheme.
export type Delivery =
  | { readonly kind: "forwarder"; readonly urlV: number }
  | { readonly kind: "cli" };

// A click whose copy and open act on the desktop the person sits at, named by
// the daemon so the acts it asks come back to that click and no other.
declare const DESKTOP_CLICK: unique symbol;
export type DesktopClickId = string & { readonly [DESKTOP_CLICK]: true };

// [LAW:types-are-the-program] Where a click's copy and open act: on the
// machine the daemon runs on, or on the desktop the person sits at, which is
// another machine when the bar was drawn over ssh and the link came down a
// forward. It rides on the click's arrival, so every turn of the click sees it,
// a parked click's later one included.
export type ActsOn =
  | { readonly on: "daemon" }
  | { readonly on: "desktop"; readonly click: DesktopClickId };

export const ACTS_ON_DAEMON: ActsOn = { on: "daemon" };

// How a click reached the renderer: a link the terminal drew, with who
// delivered it and where its acts go; a range of the tmux status line, which a
// binding tmux ran delivered (no code writes that binding now, so nothing
// produces this arm); or a local command hosting its own bar.
export type ClickArrival =
  | {
      readonly via: "link";
      readonly delivery: Delivery;
      readonly acts: ActsOn;
    }
  | { readonly via: "tmux-status" }
  | { readonly via: "command" };

export const actsOn = (arrival: ClickArrival): ActsOn =>
  arrival.via === "link" ? arrival.acts : ACTS_ON_DAEMON;
