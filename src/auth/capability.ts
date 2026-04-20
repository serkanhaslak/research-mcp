import type { Context, Next } from 'hono';
import type { Env, ResolvedEnv } from '../env.js';

export interface Capability {
  email: string;
  secretHash: string;
  revoked: boolean;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function lookupCapability(
  db: D1Database,
  plaintextSecret: string
): Promise<Capability | null> {
  const hash = await sha256Hex(plaintextSecret);
  const row = await db
    .prepare('SELECT email, revoked FROM allowed_clients WHERE secret_hash = ? LIMIT 1')
    .bind(hash)
    .first<{ email: string; revoked: number }>();

  if (!row || row.revoked) return null;
  return { email: row.email, secretHash: hash, revoked: false };
}

export function markUsed(db: D1Database, secretHash: string): Promise<unknown> {
  return db
    .prepare('UPDATE allowed_clients SET last_used_at = ? WHERE secret_hash = ?')
    .bind(Date.now(), secretHash)
    .run();
}

/**
 * Hono middleware: require a valid capability secret in the :secret path param.
 * On success, sets c.var.capability and forwards. On failure, returns JSON 401.
 */
export async function requireCapability(
  c: Context<{ Bindings: Env; Variables: { capability: Capability; resolved: ResolvedEnv } }>,
  next: Next
) {
  const secret = c.req.param('secret');
  if (!secret) {
    return c.json({ error: 'invalid_capability', error_description: 'Missing capability secret' }, 401);
  }

  const resolved = c.get('resolved');
  const cap = await lookupCapability(resolved.AUTH_DB, secret);
  if (!cap) {
    return c.json(
      { error: 'invalid_capability', error_description: 'Unknown or revoked capability secret' },
      401
    );
  }

  c.set('capability', cap);
  // Fire-and-forget — never block the request on the usage stamp.
  c.executionCtx.waitUntil(markUsed(resolved.AUTH_DB, cap.secretHash));
  return next();
}
