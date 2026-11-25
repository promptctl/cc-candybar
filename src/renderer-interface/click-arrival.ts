// [LAW:types-are-the-program] Who delivered a link to the daemon: the URL
// handler app, forwarding it raw in a frame of the version it spells, or
// `cc-candybar url-handle`, which splits the verb itself — run by hand, or by
// the retired AppleScript applet an old install left registered for the scheme.
// A forwarder that asked for the click's copy and open (`actsOn: desktop` in
// its frame) is its own arm, since they act on its machine and not the
// daemon's: such a click is answered when its turn ends, and a copy or open it
// asks after that has no answer to ride in. The same click, run again after
// its answer went (a parked click's replay), is the arm that says so.
export type Delivery =
  | { readonly kind: "forwarder"; readonly urlV: number }
  | { readonly kind: "desktop-forwarder"; readonly urlV: number }
  | { readonly kind: "answered-desktop-forwarder"; readonly urlV: number }
  | { readonly kind: "cli" };

// How a click reached the renderer: a link the terminal drew, with who
// delivered it; a range of the tmux status line, which a binding tmux ran
// delivered (no code writes that binding now, so nothing produces this arm); or
// a local command hosting its own bar.
export type ClickArrival =
  | { readonly via: "link"; readonly delivery: Delivery }
  | { readonly via: "tmux-status" }
  | { readonly via: "command" };

// [LAW:single-enforcer] Whether a click's copy and open act on its writer's
// machine, read from how it was delivered: the one place the frame's say on it
// is kept, so the host that performs the acts and the renderer that asks them
// cannot disagree.
export const actsOnDesktop = (arrival: ClickArrival): boolean =>
  arrival.via === "link" && arrival.delivery.kind === "desktop-forwarder";

// The arrival of a click run once its answer has been sent, where its copy and
// open have nowhere to go. Every other arrival is unchanged.
export const afterItsAnswer = (arrival: ClickArrival): ClickArrival =>
  arrival.via === "link" && arrival.delivery.kind === "desktop-forwarder"
    ? {
        via: "link",
        delivery: {
          kind: "answered-desktop-forwarder",
          urlV: arrival.delivery.urlV,
        },
      }
    : arrival;

export const answerSent = (arrival: ClickArrival): boolean =>
  arrival.via === "link" &&
  arrival.delivery.kind === "answered-desktop-forwarder";
