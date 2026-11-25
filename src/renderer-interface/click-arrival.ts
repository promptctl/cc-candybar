// [LAW:types-are-the-program] Who delivered a link to the daemon: the URL
// handler app, forwarding it raw in a frame of the version it spells, or
// `cc-candybar url-handle`, which splits the verb itself — run by hand, or by
// the retired AppleScript applet an old install left registered for the scheme.
// A forwarder that asked for the click's copy and open (`actsOn: desktop` in
// its frame) is its own arm, since they act on its machine and not the
// daemon's: such a click is answered when its turn ends and cannot wait for
// anything later, where a plain forwarder's can.
export type Delivery =
  | { readonly kind: "forwarder"; readonly urlV: number }
  | { readonly kind: "desktop-forwarder"; readonly urlV: number }
  | { readonly kind: "cli" };

// How a click reached the renderer: a link the terminal drew, with who
// delivered it; a range of the tmux status line, which a binding tmux ran
// delivered (no code writes that binding now, so nothing produces this arm); or
// a local command hosting its own bar.
export type ClickArrival =
  | { readonly via: "link"; readonly delivery: Delivery }
  | { readonly via: "tmux-status" }
  | { readonly via: "command" };
