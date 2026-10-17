/** All internal time handling is UTC epoch milliseconds. */

/** Windows are aligned to the Unix epoch, so 1h windows are UTC clock hours. */
export function windowStart(index: number, windowMs: number): number {
  return index * windowMs;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
