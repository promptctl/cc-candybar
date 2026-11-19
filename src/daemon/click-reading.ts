// [LAW:single-enforcer] The URL handler and CLI enter through the same
// signature and argument admission before a click reaches a renderer.

import type { LinkSigner } from "../click/link-signer.js";
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
  const link = parseHandlerUrl(opened.value);
  if (!link.ok) return { kind: "refused", problem: link.problem };
  try {
    return {
      kind: "link",
      ...admitClick(link.verb, link.value, links),
      link: opened.value,
      delivery,
    };
  } catch (e) {
    if (!(e instanceof BadVerbArgs)) throw e;
    return {
      kind: "refused",
      problem: e.message,
      signed: { link: opened.value, verb: link.verb },
    };
  }
}
