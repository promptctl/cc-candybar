// [LAW:types-are-the-program] Who delivered a link to the daemon: the URL
// handler app, forwarding it raw in a frame of the version it spells, or
// `cc-candybar url-handle`, which splits the verb itself — run by the tmux
// status line's click binding, or by the retired AppleScript applet an old
// install left registered for the scheme.
export type Delivery =
  | { readonly kind: "forwarder"; readonly urlV: number }
  | { readonly kind: "cli" };

// How a click reached the renderer: a link the terminal drew, with who
// delivered it; a range of the tmux status line, which tmux's own binding
// runs — proof that the bar is on screen; or a local command hosting its own bar.
export type ClickArrival =
  | { readonly via: "link"; readonly delivery: Delivery }
  | { readonly via: "tmux-status" }
  | { readonly via: "command" };
