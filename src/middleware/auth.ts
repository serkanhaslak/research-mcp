import type { Context, Next } from 'hono';
import type { Env } from '../env.js';
import type { Capability } from '../auth/capability.js';

/**
 * Validates Bearer token from Authorization header (RFC 6750) and confirms the token
 * was issued under the capability in the current URL path. Mounted under
 * /s/:secret/mcp/* so the capability is already on c.var.
 */
export async function requireOAuth(
  c: Context<{ Bindings: Env; Variables: { capability: Capability; authenticated: boolean } }>,
  next: Next
) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing or invalid Authorization header' },
        id: null,
      },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    );
  }

  const token = authHeader.slice(7);
  const storedRaw = await c.env.OAUTH_TOKENS.get(`token:${token}`, 'json') as
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
  const cap = c.get('capability');
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
