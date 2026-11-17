// [LAW:parse-dont-validate] A renderer's name: what a request asks for and
// what its profile derives from (src/daemon/paths.ts), so it is one path
// segment, checked once where it arrives.
export type RendererName = string & { readonly __brand: "RendererName" };

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseRendererName(raw: string): RendererName | null {
  return NAME.test(raw) ? (raw as RendererName) : null;
}

// The renderer every session draws with unless it asks for another.
export const MAIN_RENDERER = "main" as RendererName;
