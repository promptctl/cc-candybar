// [LAW:types-are-the-program] Who delivered a link to the daemon: the URL
// handler app, forwarding it raw in a frame of the version it spells, or
// `cc-candybar url-handle`, which splits the verb itself — run by hand, or by
// the retired AppleScript applet an old install left registered for the scheme.
export type Delivery =
  | {
      readonly kind: "forwarder";
      readonly urlV: number;
      readonly actsOn: ActsOn;
    }
  | { readonly kind: "cli" };

// [LAW:types-are-the-program] Where a click's copy and open act: on the
// machine the daemon runs on, or on the desktop the person sits at, which is
// another machine when the bar was drawn over ssh and the link came down a
// forward. It rides on the click's arrival, so every turn of the click sees it.
export type ActsOn = "daemon" | "desktop";

// How a click reached the renderer: a link the terminal drew, with who
// delivered it; a range of the tmux status line, which a binding tmux ran
// delivered (no code writes that binding now, so nothing produces this arm); or
// a local command hosting its own bar.
export type ClickArrival =
  | { readonly via: "link"; readonly delivery: Delivery }
  | { readonly via: "tmux-status" }
  | { readonly via: "command" };

export const deliveredTo = (delivery: Delivery): ActsOn =>
  delivery.kind === "forwarder" ? delivery.actsOn : "daemon";

export const actsOn = (arrival: ClickArrival): ActsOn =>
  arrival.via === "link" ? deliveredTo(arrival.delivery) : "daemon";
