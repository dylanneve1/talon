/**
 * What a native tool hands back: the `Result` shape every handler in this
 * directory returns, and the renderer that turns an exec run (local or
 * teleported) into the `[where] status / stdout / stderr` block the model
 * reads.
 */

import { clampExecOutput } from "../../../../util/exec-output.js";

export type Result = {
  ok: boolean;
  text: string;
  /** Set for image files so the tool result carries a viewable image block. */
  image?: { data: string; mimeType: string };
};

export function renderExec(
  where: string,
  status: string,
  stdout: string,
  stderr: string,
): string {
  const parts = [`[${where}] ${status}`];
  if (stdout.trim())
    parts.push(
      `--- stdout ---\n${clampExecOutput(stdout.replace(/\s+$/, ""))}`,
    );
  if (stderr.trim())
    parts.push(
      `--- stderr ---\n${clampExecOutput(stderr.replace(/\s+$/, ""))}`,
    );
  if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}
