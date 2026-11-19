// [LAW:single-enforcer] The host's one reading of a click, whoever delivered
// it: the URL handler app's frame, or `cc-candybar url-handle`. Any web page
// can open a `cc-candybar://` link, so no link reaches a renderer until its
// signature is opened here. A range of the tmux status line carries none,
// because tmux expands it and nothing signs it, so the host reads it as its own
// arm before any key is asked for.

import type { LinkSigner } from "../click/link-signer.js";
import {
  isBarLink,
  parseHandlerUrl,
  STATUS_LINE_CLICK_PREFIX,
  URL_SCHEME,
} from "../click/wire.js";
import type { Delivery } from "../renderer-interface/click-arrival.js";

interface Refused {
  readonly kind: "refused";
  readonly problem: string;
}

// A link the bar drew, opened: its verb and its still-encoded value, and the
// link with its signature taken off, for the click's event.
export type OpenedLink =
  | {
      readonly kind: "link";
      readonly verb: string;
      readonly value: string;
      readonly link: string;
    }
  | Refused;

// [LAW:types-are-the-program] A click as the host reads it, with who
// delivered it where that is a fact of what it does.
export type ReadClick =
  | (Extract<OpenedLink, { kind: "link" }> & { readonly delivery: Delivery })
  // A status-line range: `[socket, pane, range]` as segments.
  | { readonly kind: "status-line"; readonly value: string }
  | Refused;

export function parseClick(
  url: string,
  delivery: Delivery,
  links: LinkSigner,
): ReadClick {
  if (url.startsWith(STATUS_LINE_CLICK_PREFIX)) {
    // [LAW:no-silent-failure] Only the tmux binding runs a range, and it runs
    // the CLI; one through the URL handler came from a page.
    return delivery.kind === "cli"
      ? {
          kind: "status-line",
          value: url.slice(STATUS_LINE_CLICK_PREFIX.length),
        }
      : {
          kind: "refused",
          problem: "a status-line click comes only from tmux's own binding",
        };
  }
  if (!isBarLink(url))
    return {
      kind: "refused",
      problem: `expected a ${URL_SCHEME}:// link, got: ${url}`,
    };
  const opened = openClick(url, links);
  return opened.kind === "link" ? { ...opened, delivery } : opened;
}

// A link a frame drew, opened by its signature and split as a click: what a
// clicked link is, and what a status-line range resolves to.
export function openClick(signed: string, links: LinkSigner): OpenedLink {
  const opened = links.openLink(signed);
  if (opened.kind === "failed")
    return { kind: "refused", problem: opened.reason };
  const link = parseHandlerUrl(opened.value);
  return link.ok
    ? { kind: "link", verb: link.verb, value: link.value, link: opened.value }
    : { kind: "refused", problem: link.problem };
}
