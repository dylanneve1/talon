/**
 * Proxy-aware fetch — uses HTTP_PROXY/HTTPS_PROXY env vars if set.
 * Node's built-in fetch() does NOT respect proxy env vars by default.
 */

import { ProxyAgent } from "undici";

const proxyUrl =
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY ||
  "";

const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

/**
 * Drop-in replacement for global fetch() that routes through the system proxy.
 */
export async function proxyFetch(
  url: string | URL,
  init?: RequestInit & { dispatcher?: unknown },
): Promise<Response> {
  return fetch(url, {
    ...init,
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);
}
