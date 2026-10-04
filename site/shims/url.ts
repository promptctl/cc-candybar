export const fileURLToPath = (u: string | URL): string => decodeURIComponent(new URL(String(u)).pathname);
export const pathToFileURL = (p: string): URL => new URL(`file://${encodeURI(p)}`);
const U = globalThis.URL;
const S = globalThis.URLSearchParams;
export { U as URL, S as URLSearchParams };
export default { fileURLToPath, pathToFileURL, URL: U, URLSearchParams: S };
