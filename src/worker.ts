import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env, ResolvedEnv } from './env.js';
import { resolveEnv } from './env.js';
import type { Capability } from './auth/capability.js';
import { requireCapability } from './auth/capability.js';

import { healthRoutes } from './routes/health.js';
import { mcpRoutes } from './routes/mcp.js';
import { oauthRoutes } from './routes/oauth.js';
import { discoveryRoutes } from './routes/discovery.js';

type Vars = { resolved: ResolvedEnv; capability: Capability; authenticated: boolean };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('*', logger());
app.use('*', cors());

// Resolve secrets + D1 for anything that needs them.
app.use('/s/:secret/*', async (c, next) => {
  c.set('resolved', await resolveEnv(c.env));
  return next();
});
app.use('/.well-known/*', async (c, next) => {
  c.set('resolved', await resolveEnv(c.env));
  return next();
});

// Capability gate on the sensitive subpaths. Discovery self-validates so it doesn't need this.
app.use('/s/:secret/oauth/*', requireCapability);
app.use('/s/:secret/mcp', requireCapability);
app.use('/s/:secret/mcp/*', requireCapability);

// Discovery (both RFC 9728 path-suffix and RFC 8414 issuer forms) — mounted at root, self-validating.
app.route('/', discoveryRoutes);

// OAuth + MCP live under the capability prefix.
app.route('/s/:secret/oauth', oauthRoutes);
app.route('/s/:secret/mcp', mcpRoutes);

app.route('/', healthRoutes);

app.get('/', (c) =>
  c.json({
    name: c.env.SERVER_NAME,
    version: c.env.SERVER_VERSION,
    protocol: c.env.MCP_PROTOCOL_VERSION,
    transport: 'streamable-http',
    note: 'Connect with the capability URL issued to your email (https://.../s/<secret>/mcp).',
  })
);

// Bare /mcp — point people at their capability URL.
const capabilityReminder = {
  error: 'capability_url_required',
  error_description:
    'Use your issued capability URL: https://research-mcp.pragmaticgrowth.com/s/<your-secret>/mcp',
};
app.all('/mcp', (c) => c.json(capabilityReminder, 404));
app.all('/mcp/*', (c) => c.json(capabilityReminder, 404));

app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

app.onError((err, c) => {
  console.error('Unhandled error:', err.message, err.stack);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
