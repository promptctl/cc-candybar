// [LAW:no-ambient-temporal-coupling] A named condition, polled until it holds
// or loudly failed at its budget — never a sleep standing in for it, and never
// a silent give-up that leaves the next assertion to fail without the cause.
export async function until(
  reached: () => boolean,
  what: string,
  budgetMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!reached()) {
    if (Date.now() >= deadline)
      throw new Error(`${what} did not hold within ${budgetMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
