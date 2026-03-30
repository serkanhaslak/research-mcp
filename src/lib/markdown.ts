/**
 * Markdown utilities — HTML→Markdown conversion, sanitization, meta tag removal
 */
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

turndown.remove(['script', 'style', 'nav', 'footer', 'aside', 'noscript']);

const MAX_CONTENT_LENGTH = 524_288;

function removeHtmlComments(html: string): string {
  const parts: string[] = [];
  let pos = 0;
  while (pos < html.length) {
    const start = html.indexOf('<!--', pos);
    if (start === -1) { parts.push(html.substring(pos)); break; }
    if (start > pos) parts.push(html.substring(pos, start));
    const end = html.indexOf('-->', start + 4);
    if (end === -1) { parts.push(html.substring(start)); break; }
    pos = end + 3;
  }
  return parts.join('');
}

export function sanitizeForJson(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF]/g, '');
}

export function htmlToMarkdown(htmlContent: string): string {
  try {
    if (!htmlContent || typeof htmlContent !== 'string') return htmlContent || '';
    if (!htmlContent.includes('<')) return htmlContent.trim();
    if (htmlContent.length > MAX_CONTENT_LENGTH) {
      htmlContent = htmlContent.substring(0, MAX_CONTENT_LENGTH);
    }
    let content = removeHtmlComments(htmlContent);
    content = turndown.turndown(content);
    content = sanitizeForJson(content);
    content = content.replace(/\n{3,}/g, '\n\n');
    return content.trim();
  } catch {
    return htmlContent || '';
  }
}

export function removeMetaTags(content: string): string {
  if (!content || typeof content !== 'string') return content;
  return content.split('\n').filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith('- Meta:') && !trimmed.startsWith('Meta:');
  }).join('\n');
}
