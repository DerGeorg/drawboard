import { MAX_TEXT_LENGTH } from '@apps/drawboard-engine';

/** Link schemes a user text may open (architecture S5.3). */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

const URL_PATTERN = /(?:https?:\/\/|mailto:)[^\s<>"']+/gi;

/** Returns the URL if it is safe to link, else undefined. */
export function safeUrl(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Renders plain text into `target` with createElement/createTextNode only (never innerHTML,
 * S5.2); URLs with an allowed scheme become links (S5.3). Replaces the children of `target`.
 */
export function renderSafeText(target: HTMLElement, text: string): void {
  const doc = target.ownerDocument;
  const limited = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
  const nodes: Node[] = [];
  let last = 0;
  for (const match of limited.matchAll(URL_PATTERN)) {
    const index = match.index;
    // trailing punctuation belongs to the sentence, not to the link
    const raw = match[0].replace(/[.,;:!?)\]]+$/, '');
    const href = safeUrl(raw);
    if (!href) {
      continue;
    }
    if (index > last) {
      nodes.push(doc.createTextNode(limited.slice(last, index)));
    }
    const a = doc.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.referrerPolicy = 'no-referrer';
    a.title = new URL(href).host || href;
    a.textContent = raw;
    nodes.push(a);
    last = index + raw.length;
  }
  if (last < limited.length) {
    nodes.push(doc.createTextNode(limited.slice(last)));
  }
  target.replaceChildren(...nodes);
}
