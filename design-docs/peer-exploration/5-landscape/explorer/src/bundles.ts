// The bundles tools/export.py writes, by kind: 'bars' (what each project's statusline printed) and
// 'detail' (the long text the project view shows). A bundle is a script that hands its packed
// contents (gzip, base64) to ccBundle, so it loads from disk with no server. Each bundle loads
// once, the first time a project in it is opened.
import { pageUrl } from './site';

export type Kind = 'bars' | 'detail';
type Group = Record<string, unknown>;

const arrived = new Map<string, (g: Promise<Group>) => void>();
const loading = new Map<string, Promise<Group>>();

const inflate = (packed: string): Promise<Group> => {
  const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
};

// Called by each bundle script as it runs.
(window as unknown as { ccBundle: (kind: Kind, n: number, packed: string) => void }).ccBundle = (kind, n, packed) => {
  arrived.get(`${kind}:${n}`)?.(inflate(packed));
};

export function bundle<T>(kind: Kind, n: number): Promise<Record<string, T>> {
  const key = `${kind}:${n}`;
  let p = loading.get(key);
  if (p === undefined) {
    p = new Promise<Group>((resolve, reject) => {
      arrived.set(key, resolve);
      const s = document.createElement('script');
      s.src = pageUrl(`${kind}/b${String(n).padStart(3, '0')}.js`);
      s.onerror = () => reject(new Error(`${kind} bundle ${n} did not load`));
      document.head.append(s);
    });
    loading.set(key, p);
  }
  return p as Promise<Record<string, T>>;
}
