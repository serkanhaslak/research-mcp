import type { Context, Next } from 'hono';
import type { Env } from '../env.js';
import type { Capability } from '../auth/capability.js';

/**
 * Auth for /s/:secret/mcp/*. The capability secret in the URL has already been
 * validated by `requireCapability`, which is the real gate. On top of that we
 * accept (in this order):
 *
 *   1. No Authorization header → allowed (capability URL alone is enough; this
 *      is what plain MCP HTTP clients like Droid use).
 *   2. `Authorization: Bearer <capability-secret>` → allowed (API-key style;
 *      same secret as the URL, just echoed in the header).
 *   3. `Authorization: Bearer <oauth-access-token>` → allowed only if the token
 *      was minted under this same capability (Claude.ai DCR/PKCE flow).
 *
 * Any other Bearer value is rejected.
 */
export async function requireOAuth(
  c: Context<{ Bindings: Env; Variables: { capability: Capability; authenticated: boolean } }>,
  next: Next
) {
  const cap = c.get('capability');
  const authHeader = c.req.header('Authorization');

  // Path #1: no Authorization header. The capability URL already proved access.
  if (!authHeader) {
    c.set('authenticated', true);
    return next();
  }

  if (!authHeader.startsWith('Bearer ')) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authorization header must use the Bearer scheme' },
        id: null,
      },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    );
  }

  const token = authHeader.slice(7).trim();

  // Path #2: API-key mode. Bearer == the capability secret in the URL.
  const urlSecret = c.req.param('secret');
  if (token && urlSecret && token === urlSecret) {
    c.set('authenticated', true);
    return next();
  }

  // Path #3: OAuth access token issued via DCR/PKCE.
  const storedRaw = (await c.env.OAUTH_TOKENS.get(`token:${token}`, 'json')) as
    | { capability_hash?: string }
    | null;

  if (!storedRaw) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Invalid or expired token' },
        id: null,
      },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } }
    );
  }

  // Cross-capability token reuse is not allowed.
  if (cap && storedRaw.capability_hash && storedRaw.capability_hash !== cap.secretHash) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Token was issued for a different capability URL' },
        id: null,
      },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } }
    );
  }

  c.set('authenticated', true);
  return next();
}
