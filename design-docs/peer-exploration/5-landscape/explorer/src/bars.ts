// The captured bars, by repo. They are most of the page's bytes and compress twentyfold, so
// export.py ships them gzipped and base64 inside the page, and they are inflated once here.
import packed from './bars.json.gz.b64?raw';
import type { Bars } from './types';

const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
export const bars: Promise<Record<string, Bars>> = new Response(
  new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
).json();
