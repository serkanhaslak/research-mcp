import { Hono } from 'hono';
import type { Env, ResolvedEnv } from '../env.js';
import { verifyPKCE, generateToken } from '../oauth/pkce.js';
import type { Capability } from '../auth/capability.js';

export const oauthRoutes = new Hono<{
  Bindings: Env;
  Variables: { resolved: ResolvedEnv; capability: Capability };
}>();

// RFC 7591 Dynamic Client Registration (open, scoped to the capability URL).
// The capability secret in the URL path is the real gate — anyone who can reach this
// endpoint already proved possession of a valid secret.
oauthRoutes.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    redirect_uris?: string[];
    client_name?: string;
  };
  const clientId = crypto.randomUUID();

  await c.get('resolved').OAUTH_TOKENS.put(
    `client:${clientId}`,
    JSON.stringify({
      client_id: clientId,
      redirect_uris: body.redirect_uris || [],
      client_name: body.client_name || 'MCP Client',
      capability_hash: c.get('capability').secretHash,
      created_at: new Date().toISOString(),
    }),
    { expirationTtl: 60 * 60 * 24 * 365 }
  );

  return c.json(
    {
      client_id: clientId,
      client_name: body.client_name || 'MCP Client',
      redirect_uris: body.redirect_uris || [],
    },
    201
  );
});

async function handleAuthorize(
  params: Record<string, string | undefined>,
  env: ResolvedEnv,
  capabilityHash: string
) {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = params;

  if (!client_id || !redirect_uri || !code_challenge) {
    return { error: 'invalid_request', error_description: 'Missing required parameters', status: 400 as const };
  }
  if (code_challenge_method && code_challenge_method !== 'S256') {
    return { error: 'invalid_request', error_description: 'Only S256 supported', status: 400 as const };
  }

  const clientRaw = (await env.OAUTH_TOKENS.get(`client:${client_id}`, 'json')) as {
    redirect_uris?: string[];
    capability_hash?: string;
  } | null;
  if (!clientRaw) {
    return { error: 'invalid_client', error_description: 'Unknown client_id', status: 400 as const };
  }
  // Defense in depth: a client registered via capability A cannot be used via capability B.
  if (clientRaw.capability_hash && clientRaw.capability_hash !== capabilityHash) {
    return { error: 'invalid_client', error_description: 'Client belongs to a different capability', status: 403 as const };
  }
  if (clientRaw.redirect_uris && clientRaw.redirect_uris.length > 0) {
    if (!clientRaw.redirect_uris.includes(redirect_uri)) {
      return { error: 'invalid_request', error_description: 'redirect_uri not registered', status: 400 as const };
    }
  }

  const code = crypto.randomUUID();
  await env.OAUTH_TOKENS.put(
    `code:${code}`,
    JSON.stringify({
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method: code_challenge_method || 'S256',
      scope: scope || 'mcp:tools',
      capability_hash: capabilityHash,
      created_at: Date.now(),
    }),
    { expirationTtl: 600 }
  );

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  return { redirect: redirectUrl.toString() };
}

oauthRoutes.get('/authorize', async (c) => {
  const result = await handleAuthorize(
    c.req.query(),
    c.get('resolved'),
    c.get('capability').secretHash
  );
  if ('error' in result) return c.json({ error: result.error, error_description: result.error_description }, result.status);
  return c.redirect(result.redirect, 302);
});

oauthRoutes.post('/authorize', async (c) => {
  const body = await c.req.parseBody();
  const result = await handleAuthorize(
    body as Record<string, string>,
    c.get('resolved'),
    c.get('capability').secretHash
  );
  if ('error' in result) return c.json({ error: result.error, error_description: result.error_description }, result.status);
  return c.redirect(result.redirect, 302);
});

oauthRoutes.post('/token', async (c) => {
  const body = await c.req.parseBody();
  const { grant_type, code, code_verifier, client_id, redirect_uri } = body as Record<string, string>;
  const resolved = c.get('resolved');
  const capability = c.get('capability');

  if (grant_type !== 'authorization_code') {
    return c.json({ error: 'unsupported_grant_type' }, 400);
  }
  if (!code || !code_verifier) {
    return c.json({ error: 'invalid_request', error_description: 'Missing code or code_verifier' }, 400);
  }

  const storedRaw = (await resolved.OAUTH_TOKENS.get(`code:${code}`, 'json')) as {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    scope: string;
    capability_hash: string;
  } | null;

  if (!storedRaw) {
    return c.json({ error: 'invalid_grant', error_description: 'Code expired or invalid' }, 400);
  }
  await resolved.OAUTH_TOKENS.delete(`code:${code}`);

  if (storedRaw.capability_hash !== capability.secretHash) {
    return c.json({ error: 'invalid_grant', error_description: 'Code issued under a different capability' }, 400);
  }
  if (client_id && client_id !== storedRaw.client_id) {
    return c.json({ error: 'invalid_grant', error_description: 'client_id mismatch' }, 400);
  }
  if (redirect_uri && redirect_uri !== storedRaw.redirect_uri) {
    return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
  }

  const pkceValid = await verifyPKCE(code_verifier, storedRaw.code_challenge);
  if (!pkceValid) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
  }

  const accessToken = generateToken();
  const expiresIn = 60 * 60 * 24 * 30; // 30 days

  await resolved.OAUTH_TOKENS.put(
    `token:${accessToken}`,
    JSON.stringify({
      client_id: storedRaw.client_id,
      scope: storedRaw.scope,
      capability_hash: capability.secretHash,
      email: capability.email,
      created_at: Date.now(),
    }),
    { expirationTtl: expiresIn }
  );

  return c.json({
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: expiresIn,
    scope: storedRaw.scope,
  });
});

oauthRoutes.post('/revoke', async (c) => {
  const body = await c.req.parseBody();
  const token = body.token as string;
  if (token) await c.get('resolved').OAUTH_TOKENS.delete(`token:${token}`);
  return c.json({ success: true });
});
