import { RichText, Style } from "@promptctl/rich-js";
import type { FuncMap, TemplateFunc } from "@promptctl/go-template-js";
import type { DrawnLink, LinkTarget } from "./drawn-link.js";

const PROOF = Symbol("Candybar link target");
const MARKER = "candybar-span:";

class LinkProof {
  readonly marker: string;
  readonly target: LinkTarget;

  constructor(target: LinkTarget) {
    this.target =
      target.kind === "action"
        ? Object.freeze({
            kind: "action",
            effect: Object.freeze({
              verb: target.effect.verb,
              args: Object.freeze([...target.effect.args] as const),
            }),
          })
        : Object.freeze({ ...target });
    // [LAW:one-source-of-truth] Style.equals compares links and ignores meta.
    // The marker is the equality projection of the target kept with the span.
    this.marker = `${MARKER}${Buffer.from(JSON.stringify(this.target)).toString("base64url")}`;
  }
}

export function styleWithLink(style: Style, link: DrawnLink): Style {
  if (typeof link === "string") return style.withLink(link);
  const proof = new LinkProof(link);
  return style.add(new Style({ link: proof.marker, meta: { [PROOF]: proof } }));
}

// [LAW:single-enforcer] Only the proof for the actual winning link projects an
// action. A style overlay can replace the link while leaving old meta behind.
export function linkFromStyle(style: Style): DrawnLink | undefined {
  const { link, meta } = style;
  const proof: unknown =
    meta === undefined ? undefined : Reflect.get(meta, PROOF);
  if (proof instanceof LinkProof && proof.marker === link) return proof.target;
  return link?.startsWith(MARKER) ? undefined : link;
}

// [LAW:single-enforcer] Wrap the two rich-js bindings that accept authored
// URLs. Use the link RichText already sanitized, before a fragment can compose
// with other styles. Authored hrefs in the marker namespace keep their literal
// bytes. Every other href retains its original Style.
export function authoredLinks(funcs: FuncMap): FuncMap {
  const link = funcs.link;
  const style = funcs.style;
  if (link === undefined || style === undefined) {
    throw new Error("rich-js is missing its link or style template binding");
  }
  const project = (
    binding: TemplateFunc,
    input: string,
    child: unknown,
    setsLink: boolean,
  ): RichText => {
    const result: unknown = Reflect.apply(binding.fn, undefined, [
      input,
      child,
    ]);
    if (!(result instanceof RichText)) {
      throw new TypeError(
        "rich-js link and style bindings must return RichText",
      );
    }
    if (!setsLink || typeof result.style === "string") return result;
    const layered = result.style;
    const base = layered instanceof Style ? layered : layered.over;
    const url = base.link;
    if (url?.startsWith(MARKER)) {
      const quoted = styleWithLink(base, { kind: "href", url });
      result.style =
        layered instanceof Style ? quoted : { ...layered, over: quoted };
    }
    return result;
  };
  return {
    ...funcs,
    link: {
      ...link,
      fn: (url: string, child: unknown) =>
        project(link, url, child, url !== ""),
    },
    style: {
      ...style,
      fn: (spec: string, child: unknown) =>
        project(style, spec, child, Style.parse(spec).link !== undefined),
    },
  };
}
