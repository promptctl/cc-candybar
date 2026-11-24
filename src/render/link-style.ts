import { RichText, Style } from "@promptctl/rich-js";
import type { FuncMap, TemplateFunc } from "@promptctl/go-template-js";
import type { DrawnEffect, DrawnLink, LinkTarget } from "./drawn-link.js";

const PROOF = Symbol("Candybar link target");
const MARKER = "candybar-span:";

function capture(effect: DrawnEffect): DrawnEffect {
  if ("verb" in effect)
    return Object.freeze({ ...effect, args: Object.freeze([...effect.args]) });
  const { run, env } = effect.evaluated;
  return Object.freeze({
    ...effect,
    evaluated: Object.freeze({
      run: Object.freeze([...run]),
      env: Object.freeze({ ...env }),
    }),
  });
}

class LinkProof {
  readonly marker: string;
  readonly target: LinkTarget;

  constructor(target: LinkTarget) {
    this.target =
      target.kind === "action"
        ? Object.freeze({
            ...target,
            effects: Object.freeze(target.effects.map(capture)),
            ...(target.region === undefined
              ? {}
              : {
                  region: Object.freeze({
                    name: target.region.name,
                    ...(target.region.hover === undefined
                      ? {}
                      : {
                          hover: Object.freeze(
                            target.region.hover.map(capture),
                          ),
                        }),
                    gestures: Object.freeze(
                      Object.fromEntries(
                        Object.entries(target.region.gestures).map(
                          ([gesture, effects]) => [
                            gesture,
                            Object.freeze(effects.map(capture)),
                          ],
                        ),
                      ),
                    ),
                  }),
                }),
          })
        : Object.freeze({ ...target });
    // [LAW:one-source-of-truth] Style.equals compares links and ignores meta.
    // The marker is the equality projection of the target kept with the span.
    this.marker = MARKER + encodeURIComponent(JSON.stringify(this.target));
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
