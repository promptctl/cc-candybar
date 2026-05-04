export function debug(message: string, ...args: unknown[]): void {
  if (process.env.CC_CANDYBAR_DEBUG) {
    console.error(`[DEBUG] ${message}`, ...args);
  }
}
