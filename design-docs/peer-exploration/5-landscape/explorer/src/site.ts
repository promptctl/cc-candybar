// Where this page sits among the published site's pages.

// A path from this page, resolved against the page's own address rather than the document base: a
// deploy may inject a base tag pointing at its version root, and this page sits below that root.
export const pageUrl = (path: string): string => new URL(path, location.href).href;

// The live bar's path from this page. The site's deploy decides where it publishes the explorer and
// the build derives this from it; a build outside the deploy has no live bar beside it, so null.
export const LIVE_BAR: string | null = __LIVE_BAR__;
