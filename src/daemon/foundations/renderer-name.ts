// [LAW:types-are-the-program] A renderer's name: what its profile is derived
// from (src/daemon/paths.ts), and what its lines in the host's log say.
declare const RENDERER_NAME: unique symbol;
export type RendererName = string & { readonly [RENDERER_NAME]: true };

// The renderer every installed bar runs, whose profile is today's layout.
export const MAIN_RENDERER = "main" as RendererName;

// [LAW:parse-dont-validate] A name is a path segment of its profile, so only
// lowercase letters, digits and inner dashes: no spelling of one names
// another's directory.
export function rendererNameOf(raw: string): RendererName {
  const name = parsedRendererName(raw);
  if (name === null)
    throw new Error(
      `${JSON.stringify(raw)} is no renderer name: lowercase letters, digits and inner dashes, up to 32`,
    );
  return name;
}

// The same grammar, for a reader to whom a string that is no name is an
// answer rather than an error: none.
export function parsedRendererName(raw: string): RendererName | null {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(raw)
    ? (raw as RendererName)
    : null;
}
