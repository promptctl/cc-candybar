// [LAW:single-enforcer] The URL handler and CLI enter through the same
// signature and argument admission before a click reaches a renderer.

import type { FrameSource, LinkSigner } from "../click/link-signer.js";
import {
  admitClick,
  isBarLink,
  parseHandlerUrl,
  URL_SCHEME,
  type ClickAdmission,
} from "../click/wire.js";
import type { Delivery } from "../renderer-interface/click-arrival.js";
import { BadVerbArgs } from "./foundations/verb-error.js";

export type ReadClick =
  | ({
      readonly kind: "link";
      readonly link: string;
      readonly delivery: Delivery;
      readonly source?: FrameSource;
    } & ClickAdmission)
  | {
      readonly kind: "refused";
      readonly problem: string;
      readonly signed?: { readonly link: string; readonly verb: string };
    };

export function parseClick(
  url: string,
  delivery: Delivery,
  links: LinkSigner,
): ReadClick {
  if (!isBarLink(url))
    return {
      kind: "refused",
      problem: `expected a ${URL_SCHEME}:// link, got: ${url}`,
    };
  const opened = links.openLink(url);
  if (opened.kind === "failed")
    return { kind: "refused", problem: opened.reason };
  const { href, source } = opened.value;
  const link = parseHandlerUrl(href);
  if (!link.ok) return { kind: "refused", problem: link.problem };
  try {
    const admitted = admitClick(link.verb, link.value, links);
    const { click, runEvidence } = admitted;
    // [LAW:types-are-the-program] A published click acts for its drawing
    // session. An effect's own argument cannot switch that identity.
    if (
      source !== undefined &&
      click.scope === "session" &&
      click.session !== source.session
    )
      throw new BadVerbArgs(
        "the link's action and its frame name different sessions",
      );
    return {
      kind: "link",
      click:
        source !== undefined && click.scope === "global"
          ? { ...click, session: source.session }
          : click,
      runEvidence,
      link: href,
      delivery,
      ...(source === undefined ? {} : { source }),
    };
  } catch (e) {
    if (!(e instanceof BadVerbArgs)) throw e;
    return {
      kind: "refused",
      problem: e.message,
      signed: { link: href, verb: link.verb },
    };
  }
}
