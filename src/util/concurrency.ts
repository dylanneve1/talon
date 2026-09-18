/**
 * Bounded-concurrency map: run `fn` over `items` with at most `limit`
 * in flight, preserving result order. Rejections propagate after the
 * batch drains so a single failure does not orphan in-flight work.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  const errors: unknown[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (err) {
        errors.push(err);
      }
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  if (errors.length > 0) throw errors[0];
  return results;
}
