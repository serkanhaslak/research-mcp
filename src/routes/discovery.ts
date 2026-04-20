import { Hono } from 'hono';
import type { Env, ResolvedEnv } from '../env.js';
import { lookupCapability } from '../auth/capability.js';

export const discoveryRoutes = new Hono<{ Bindings: Env; Variables: { resolved: ResolvedEnv } }>();

// RFC 9728 Protected Resource Metadata — mounted at root with the full resource path as suffix.
// Claude.ai probes https://host/.well-known/oauth-protected-resource/s/<secret>/mcp
discoveryRoutes.get('/.well-known/oauth-protected-resource/s/:secret/mcp', async (c) => {
  const secret = c.req.param('secret');
  // Validate the capability so we don't advertise an AS for a bogus URL.
  const cap = await lookupCapability(c.get('resolved').AUTH_DB, secret);
  if (!cap) return c.json({ error: 'unknown_capability' }, 404);

  const base = originOf(c.req.url);
  return c.json({
    resource: `${base}/s/${secret}/mcp`,
    authorization_servers: [`${base}/s/${secret}`],
    bearer_methods_supported: ['header'],
  });
});

// RFC 8414 Authorization Server Metadata — issuer form, scoped under the capability prefix.
discoveryRoutes.get('/s/:secret/.well-known/oauth-authorization-server', async (c) => {
  const secret = c.req.param('secret');
  const cap = await lookupCapability(c.get('resolved').AUTH_DB, secret);
  if (!cap) return c.json({ error: 'unknown_capability' }, 404);
  const base = originOf(c.req.url);
  const issuer = `${base}/s/${secret}`;
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:tools'],
  });
});

// Same metadata also served at the alternate RFC 9728-suffix form, for clients that use it.
discoveryRoutes.get('/.well-known/oauth-authorization-server/s/:secret', async (c) => {
  const secret = c.req.param('secret');
  const cap = await lookupCapability(c.get('resolved').AUTH_DB, secret);
  if (!cap) return c.json({ error: 'unknown_capability' }, 404);

  const base = originOf(c.req.url);
  const issuer = `${base}/s/${secret}`;
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:tools'],
  });
});

function originOf(requestUrl: string): string {
  const u = new URL(requestUrl);
  return `${u.protocol}//${u.host}`;
}
