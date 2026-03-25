/**
 * Sanitize strings for safe JSON serialization.
 * Strips characters that are invalid in JSON text values.
 */

/**
 * Strip characters that are invalid in JSON strings:
 * - Null bytes and control chars U+0000–U+0008
 * - Vertical tab U+000B, form feed U+000C
 * - Control chars U+000E–U+001F
 * - Unpaired UTF-16 surrogates U+D800–U+DFFF
 *
 * Preserves tab (U+0009), newline (U+000A), carriage return (U+000D)
 * which are valid in JSON when escaped.
 */
export function sanitizeForJson(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF]/g, '');
}
