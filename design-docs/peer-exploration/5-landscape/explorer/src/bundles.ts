// The bundles tools/export.py writes, by kind: 'bars' (what each project's statusline printed) and
// 'detail' (the long text the project view shows). A bundle is a script that hands its packed
// contents (gzip, base64) to ccBundle, so it loads from disk with no server. Each bundle loads
// once, the first time a project in it is opened.
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

// A bundle that fails to arrive (a missing file, a dropped connection, a script that never calls
// ccBundle with its key) rejects with what went wrong, and is forgotten, so the next ask retries it.
// [LAW:no-silent-failure] every caller shows the rejection.
const WAIT_MS = 20_000;

export function bundle<T>(kind: Kind, n: number): Promise<Record<string, T>> {
  const key = `${kind}:${n}`;
  let p = loading.get(key);
  if (p === undefined) {
    const s = document.createElement('script');
    p = new Promise<Group>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${kind} bundle ${n} loaded but never handed over its contents`)), WAIT_MS);
      arrived.set(key, (g) => {
        clearTimeout(timer);
        resolve(g);
      });
      // Resolved against the page's own address, not the document base: a deploy may inject a base tag
      // pointing at its version root, and the bundles sit beside this page.
      s.src = new URL(`${kind}/b${String(n).padStart(3, '0')}.js`, location.href).href;
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`${kind} bundle ${n} did not load`));
      };
      document.head.append(s);
    });
    p.catch(() => {
      loading.delete(key);
      arrived.delete(key);
      s.remove();
    });
    loading.set(key, p);
  }
  return p as Promise<Record<string, T>>;
}
