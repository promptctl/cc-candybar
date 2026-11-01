// The bundles tools/export.py writes, by kind: 'bars' (what each project's statusline printed) and
// 'detail' (the long text the project view shows). A bundle is a script that hands its packed
// contents (gzip, base64) to ccBundle, so it loads from disk with no server. Each bundle loads
// once, the first time a project in it is opened.
import { pageUrl } from './site';

export type Kind = 'bars' | 'detail';
type Group = Record<string, unknown>;

const arrived = new Map<string, (g: Promise<Group>) => void>();
const loading = new Map<string, Promise<Group>>();

// async, so a malformed bundle (bad base64, bad gzip, bad JSON) rejects rather than throwing past its waiter
const inflate = async (packed: string): Promise<Group> => {
  const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  return (await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json()) as Group;
};

// Called by each bundle script as it runs. A bundle nobody is waiting for is a broken page (a
// bundle under the wrong key, or one loaded by something other than bundle()), so it throws.
(window as unknown as { ccBundle: (kind: Kind, n: number, packed: string) => void }).ccBundle = (kind, n, packed) => {
  const key = `${kind}:${n}`;
  const settle = arrived.get(key);
  if (!settle) throw new Error(`bundle ${key} arrived with nothing waiting for it`);
  arrived.delete(key);
  settle(inflate(packed));
};

// A bundle that fails to arrive (a missing file, a dropped connection, a script that runs without
// handing over its key, contents that do not inflate) rejects with what went wrong, and is
// forgotten, so the next ask retries it. [LAW:no-silent-failure] every caller shows the rejection.
export function bundle<T>(kind: Kind, n: number): Promise<Record<string, T>> {
  const key = `${kind}:${n}`;
  let p = loading.get(key);
  if (p === undefined) {
    const s = document.createElement('script');
    p = new Promise<Group>((resolve, reject) => {
      arrived.set(key, (g) => g.then(resolve, (e: Error) => reject(new Error(`${kind} bundle ${n} did not unpack: ${e.message}`))));
      // A classic script runs before its load event, so a bundle that has not handed over its
      // contents by then never will.
      s.onload = () => {
        if (arrived.delete(key)) reject(new Error(`${kind} bundle ${n} loaded but never handed over its contents`));
      };
      s.onerror = () => {
        arrived.delete(key);
        reject(new Error(`${kind} bundle ${n} did not load`));
      };
      s.src = pageUrl(`${kind}/b${String(n).padStart(3, '0')}.js`);
      document.head.append(s);
    });
    p.catch(() => {
      loading.delete(key);
      s.remove();
    });
    loading.set(key, p);
  }
  return p as Promise<Record<string, T>>;
}
