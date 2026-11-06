// [LAW:one-way-deps] The scheme a click URL carries, and the app Launch
// Services starts for it, as a leaf with no imports: the wire codec emits the
// scheme, the installer registers it, and the config loader reads it off an
// authored URL literal. The codec imports config modules (the disclosure, the
// door, the reserved names), so config importing the codec would point
// uphill; the fact sits below both instead.
// [LAW:one-source-of-truth] The scheme string lives here alone.
export const URL_SCHEME = "cc-candybar";

// The app Launch Services starts for the scheme: its bundle, binary and
// process all carry this name. Beside the scheme because it is the same fact,
// which app a click reaches, and a reader of it (the bench) wants nothing of
// the installer.
export const APP_NAME = "CCCandybarURLHandler";

// A link outside the cc-candybar scheme (a repo page, a PR) is the
// terminal's to open; the daemon never sees a click on it.
export const isBarLink = (url: string): boolean =>
  url.startsWith(`${URL_SCHEME}://`);
