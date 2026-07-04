export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 15_000;
export const RECONNECT_JITTER_RATIO = 0.25;

export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** attempt,
    RECONNECT_MAX_DELAY_MS,
  );
  const jitter = exponential * RECONNECT_JITTER_RATIO * (random() * 2 - 1);
  return Math.round(exponential + jitter);
}
