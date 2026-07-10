/**
 * Exec output guards, shared by the local native tools and the mesh exec
 * channel. Two independent ceilings:
 *
 *  - capture: how much of a child process's stream the daemon will hold in
 *    memory at all. A runaway `yes` otherwise balloons RSS for the whole
 *    timeout window before a single byte reaches the model.
 *  - render: how much of a (possibly device-supplied) stream reaches the
 *    model/chat. Clamped head+tail — the tail keeps the part of a long log
 *    where the error usually lives.
 */

/** In-memory cap while capturing one child-process output stream. */
export const MAX_EXEC_CAPTURE_BYTES = 4 * 1024 * 1024;

/** Ceiling on each rendered exec stream (stdout, stderr independently). */
export const MAX_EXEC_RENDER_CHARS = 30_000;

/**
 * Clamp one output stream for rendering: keep the head and the tail,
 * elide the middle with an explicit marker so truncation is never silent.
 */
export function clampExecOutput(
  text: string,
  max = MAX_EXEC_RENDER_CHARS,
): string {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.75);
  const tailLen = max - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  const elided = text.length - head.length - tail.length;
  return `${head}\n…[${elided.toLocaleString()} chars truncated]…\n${tail}`;
}

/**
 * Bounded accumulator for a child process's stdout/stderr. Chunks past the
 * cap are counted, not stored; `value()` appends an explicit drop marker.
 */
export function createOutputCapture(cap = MAX_EXEC_CAPTURE_BYTES): {
  push: (chunk: Buffer | string) => void;
  value: () => string;
} {
  let text = "";
  let dropped = 0;
  return {
    push: (chunk) => {
      const s = chunk.toString();
      const room = cap - text.length;
      if (room <= 0) {
        dropped += s.length;
      } else if (s.length <= room) {
        text += s;
      } else {
        text += s.slice(0, room);
        dropped += s.length - room;
      }
    },
    value: () =>
      dropped > 0
        ? `${text}\n…[${dropped.toLocaleString()} more chars dropped — output exceeded the ${Math.round(cap / (1024 * 1024))}MB capture cap]`
        : text,
  };
}
