import { Hono } from 'hono';
import type { Env } from '../env.js';
import { verifyPKCE, generateToken } from '../oauth/pkce.js';

export const oauthRoutes = new Hono<{ Bindings: Env }>();

// Dynamic client registration (RFC 7591) — required by MCP spec
oauthRoutes.post('/register', async (c) => {
  const body = await c.req.json();
  const clientId = crypto.randomUUID();

  await c.env.OAUTH_TOKENS.put(
    `client:${clientId}`,
    JSON.stringify({
      client_id: clientId,
      redirect_uris: body.redirect_uris || [],
      client_name: body.client_name || 'MCP Client',
      created_at: new Date().toISOString(),
    }),
    { expirationTtl: 60 * 60 * 24 * 365 } // 1 year
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

// Shared authorize logic — validate client, auto-approve, redirect with auth code
async function handleAuthorize(
  params: Record<string, string | undefined>,
  kv: KVNamespace,
) {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = params;

  if (!client_id || !redirect_uri || !code_challenge) {
    return { error: 'invalid_request', error_description: 'Missing required parameters', status: 400 as const };
  }

  if (code_challenge_method && code_challenge_method !== 'S256') {
    return { error: 'invalid_request', error_description: 'Only S256 supported', status: 400 as const };
  }

  // Validate client_id is registered (RFC 6749 Section 4.1.3)
  const clientRaw = await kv.get(`client:${client_id}`, 'json') as {
    redirect_uris?: string[];
  } | null;

  if (!clientRaw) {
    return { error: 'invalid_client', error_description: 'Unknown client_id', status: 400 as const };
  }

  // Validate redirect_uri against registered URIs (RFC 6749 Section 3.1.2.3)
  // If client registered with redirect_uris, enforce; otherwise allow any (open registration)
  if (clientRaw.redirect_uris && clientRaw.redirect_uris.length > 0) {
    if (!clientRaw.redirect_uris.includes(redirect_uri)) {
      return { error: 'invalid_request', error_description: 'redirect_uri not registered', status: 400 as const };
    }
  }

  const code = crypto.randomUUID();

  await kv.put(
    `code:${code}`,
    JSON.stringify({
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method: code_challenge_method || 'S256',
      scope: scope || 'mcp:tools',
      created_at: Date.now(),
    }),
    { expirationTtl: 600 }
  );

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  return { redirect: redirectUrl.toString() };
}

// GET /oauth/authorize
oauthRoutes.get('/authorize', async (c) => {
  const result = await handleAuthorize(c.req.query(), c.env.OAUTH_TOKENS);
  if ('error' in result) {
    return c.json({ error: result.error, error_description: result.error_description }, result.status);
  }
  return c.redirect(result.redirect, 302);
});

// POST /oauth/authorize — Form-based approval
oauthRoutes.post('/authorize', async (c) => {
  const body = await c.req.parseBody();
  const result = await handleAuthorize(body as Record<string, string>, c.env.OAUTH_TOKENS);
  if ('error' in result) {
    return c.json({ error: result.error, error_description: result.error_description }, result.status);
  }
  return c.redirect(result.redirect, 302);
});

// POST /oauth/token — Exchange code for access token
oauthRoutes.post('/token', async (c) => {
  const body = await c.req.parseBody();
  const { grant_type, code, code_verifier, client_id, redirect_uri } = body as Record<string, string>;

  if (grant_type !== 'authorization_code') {
    return c.json({ error: 'unsupported_grant_type' }, 400);
  }

  if (!code || !code_verifier) {
    return c.json(
      { error: 'invalid_request', error_description: 'Missing code or code_verifier' },
      400
    );
  }

  const storedRaw = (await c.env.OAUTH_TOKENS.get(`code:${code}`, 'json')) as {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    scope: string;
  } | null;

  if (!storedRaw) {
    return c.json(
      { error: 'invalid_grant', error_description: 'Code expired or invalid' },
      400
    );
  }

  // Delete code immediately (one-time use)
  await c.env.OAUTH_TOKENS.delete(`code:${code}`);

  // Validate client_id matches the one that requested the code (RFC 6749 Section 4.1.3)
  if (client_id && client_id !== storedRaw.client_id) {
    return c.json(
      { error: 'invalid_grant', error_description: 'client_id mismatch' },
      400
    );
  }

  // Validate redirect_uri matches (RFC 6749 Section 4.1.3)
  if (redirect_uri && redirect_uri !== storedRaw.redirect_uri) {
    return c.json(
      { error: 'invalid_grant', error_description: 'redirect_uri mismatch' },
      400
    );
  }

  // Verify PKCE
  const pkceValid = await verifyPKCE(code_verifier, storedRaw.code_challenge);
  if (!pkceValid) {
    return c.json(
      { error: 'invalid_grant', error_description: 'PKCE verification failed' },
      400
    );
  }

  // Generate access token
  const accessToken = generateToken();
  const expiresIn = 60 * 60 * 24 * 30; // 30 days

  await c.env.OAUTH_TOKENS.put(
    `token:${accessToken}`,
    JSON.stringify({
      client_id: storedRaw.client_id,
      scope: storedRaw.scope,
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

// POST /oauth/revoke — Revoke a token
oauthRoutes.post('/revoke', async (c) => {
  const body = await c.req.parseBody();
  const token = body.token as string;
  if (token) {
    await c.env.OAUTH_TOKENS.delete(`token:${token}`);
  }
  return c.json({ success: true });
});
