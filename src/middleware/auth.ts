import type { Context, Next } from 'hono';
import type { Env } from '../env.js';

/**
 * Validates Bearer token from Authorization header (RFC 6750).
 * Used on /mcp routes to authenticate claude.ai connections.
 */
export async function requireOAuth(
  c: Context<{ Bindings: Env; Variables: { authenticated: boolean } }>,
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
  const stored = await c.env.OAUTH_TOKENS.get(`token:${token}`);

  if (!stored) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Invalid or expired token' },
        id: null,
      },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } }
    );
  }

  c.set('authenticated', true);
  return next();
}
