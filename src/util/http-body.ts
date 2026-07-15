/**
 * Bounded reading of fetch response bodies. Content-Length is optional and
 * advisory, so the only trustworthy size limit is one enforced while the
 * body streams in.
 */

export class ResponseTooLargeError extends Error {}

/**
 * Read a response incrementally so a missing or dishonest Content-Length
 * header cannot buffer an unbounded body in memory.
 */
export async function readBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new ResponseTooLargeError();
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel("response exceeds download limit");
        } catch {
          // Cancellation is cleanup only; preserve the useful size error.
        }
        throw new ResponseTooLargeError();
      }
      chunks.push(
        Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      );
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}
