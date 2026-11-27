// [LAW:one-source-of-truth] A writer on a closed pipe may see either error,
// depending on how the peer closed and which OS supplied the pipe.
export const peerClosedPipe = (error: NodeJS.ErrnoException): boolean =>
  error.code === "EPIPE" || error.code === "ECONNRESET";
