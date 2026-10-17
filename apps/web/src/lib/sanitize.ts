import DOMPurify from 'dompurify';

/**
 * Email HTML is already sanitised by the API on write; this second pass guarantees that
 * nothing executable reaches the DOM even if stored data were tampered with.
 */
export function safeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'img'],
    FORBID_ATTR: ['srcset'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}
