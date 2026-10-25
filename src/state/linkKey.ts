// The link-key prompt, one at a time. A board whose prompt was cancelled is not asked again
// until a transport is picked.

import { Observable } from "./observable";
import { appendTerminal } from "./terminal";

export interface LinkKeyRequest {
  host: string;
  /** The board refused the key it was given. */
  wrong: boolean;
}

export const linkKeyRequest = new Observable<LinkKeyRequest | null>(null);

const declined = new Set<string>();

/** A link key is the UTF-8 bytes of the text, 8 to 64 of them. */
export function linkKeyValid(key: string): boolean {
  const n = new TextEncoder().encode(key).length;
  return n >= 8 && n <= 64;
}

export function requestLinkKey(host: string, wrong: boolean): void {
  if (linkKeyRequest.get()) return;
  if (!wrong && declined.has(host)) return;
  linkKeyRequest.set({ host, wrong });
}

/** `key` is null when the prompt was cancelled. */
export function answerLinkKey(key: string | null): void {
  const request = linkKeyRequest.get();
  if (!request) return;
  linkKeyRequest.set(null);
  if (key === null) {
    declined.add(request.host);
    appendTerminal(`[host] ${request.host} wants a link key; none given\n`);
    return;
  }
  declined.delete(request.host);
  window.neuro.setLinkKey(request.host, key);
}

/** Called when a transport is picked from the menu. */
export function forgetDeclinedLinkKeys(): void {
  declined.clear();
}
