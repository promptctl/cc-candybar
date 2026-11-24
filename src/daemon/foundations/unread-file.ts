// [LAW:one-source-of-truth] How every stored file that did not read is said,
// by the host's stores and by the repository gate alike: what could not be
// read and why, then where its bytes are now and what that means.
export const unreadText = (reason: string, where: string): string =>
  `could not be read: ${reason} — ${where}`;
