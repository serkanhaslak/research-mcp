# Research MCP — Cloudflare-Native Refactor

> **Purpose**: Complete refactor from Node.js/Railway dual-deploy to a Cloudflare-native Hono application.
> **Audience**: Claude Code agent working inside this project.
> **Date**: 2026-03-30
> **Philosophy**: Forget old patterns. Build for Cloudflare Workers from scratch. State-of-the-art.

---

## Table of Contents

1. [Goals & Non-Goals](#1-goals--non-goals)
2. [Architecture: Old vs New](#2-architecture-old-vs-new)
3. [New Project Structure](#3-new-project-structure)
4. [Phase 1: Project Setup & Wrangler Config](#4-phase-1-project-setup--wrangler-config)
5. [Phase 2: Hono App Entry Point](#5-phase-2-hono-app-entry-point)
6. [Phase 3: OAuth for Claude.ai (Critical)](#6-phase-3-oauth-for-claudeai-critical)
7. [Phase 4: MCP Protocol Handler](#7-phase-4-mcp-protocol-handler)
8. [Phase 5: Tool System](#8-phase-5-tool-system)
9. [Phase 6: External API Clients](#9-phase-6-external-api-clients)
10. [Phase 7: LLM Integration](#10-phase-7-llm-integration)
11. [Phase 8: STDIO Entry Point (npm package)](#11-phase-8-stdio-entry-point-npm-package)
12. [Phase 9: Deployment & Secrets](#12-phase-9-deployment--secrets)
13. [Environment & Bindings Reference](#13-environment--bindings-reference)
14. [File-by-File: Delete / Create / Keep](#14-file-by-file-delete--create--keep)
15. [Patterns to Preserve](#15-patterns-to-preserve)
16. [Patterns to Kill](#16-patterns-to-kill)
17. [Testing Checklist](#17-testing-checklist)
18. [Workers Compatibility Notes](#18-workers-compatibility-notes)

---

## 1. Goals & Non-Goals

### Goals
- **Cloudflare-native**: Hono + Workers + KV. No Node.js shims, no `process.env` bridging.
- **OAuth for claude.ai**: RFC 9728 compliant. Users connect via claude.ai custom connector. This is the #1 priority.
- **STDIO preserved**: npm package still works for Claude Desktop / Claude Code via `npx`.
- **Clean tool architecture**: TypeScript tool definitions. No YAML, no filesystem reads, no build-time file copying.
- **Config via bindings**: All env through Hono context `c.env`. No lazy Proxy hacks.
- **Observability**: Cloudflare native (Workers Logs, Analytics, Logpush). No custom usage tracker.
- **AI model agnostic**: Models are configurable env vars. No hardcoded model names in code. Choices made at deploy time.

### Non-Goals
- No database (D1, etc.) — this project is stateless except OAuth tokens + sessions.
- No specific AI model selection — leave as configurable env vars with sensible defaults.
- No migration of existing data — there's nothing to migrate.
- No backward compatibility with Railway deployment.
- No Durable Objects — KV is sufficient for sessions and tokens. Simpler.

---

## 2. Architecture: Old vs New

### Old (Dual Deploy, process.env, YAML, File I/O)

```
src/index.ts          ← STDIO + HTTP dual mode, session Map, process.env
src/worker.ts         ← Workers shim, process.env bridging, hardcoded descriptions
src/auth.ts           ← File-based OAuth tokens (/data/tokens.json)
src/config/loader.ts  ← YAML readFileSync (broken in Workers)
src/config/index.ts   ← Lazy Proxy config, resetEnvCache()
src/services/usage-tracker.ts ← JSONL file writes
railway.toml          ← Railway deployment
```

**Problems:**
- Two entry points that diverge (worker.ts hardcodes 5/8 tool descriptions)
- `process.env` bridging is fragile (must manually list every key)
- YAML loading incompatible with Workers (readFileSync)
- OAuth only works on Railway (file I/O)
- Usage tracking only works on Railway (file I/O)
- Session state in-memory Map (lost on redeploy)

### New (Cloudflare-Native, Hono, KV)

```
src/worker.ts         ← Hono app, Workers export, single entry point
src/stdio.ts          ← Thin STDIO wrapper for npm package (imports shared tools)
src/routes/mcp.ts     ← MCP JSON-RPC handler
src/routes/oauth.ts   ← OAuth 2.0 for claude.ai (KV-backed)
src/routes/health.ts  ← Health check
src/tools/            ← TypeScript definitions + handlers (no YAML)
src/clients/          ← External API clients (accept env, not process.env)
src/lib/              ← Shared utilities (concurrency, errors, formatting)
```

**What changes:**
- Single Workers entry point (Hono)
- OAuth tokens in KV (survives deploys, globally distributed)
- MCP sessions in KV (survives deploys)
- All config via Hono `c.env` bindings
- Tool definitions in pure TypeScript
- No file I/O anywhere
- No usage tracker (Cloudflare observability)
- STDIO entry is a thin shell that reuses tool logic

---

## 3. New Project Structure

```
research-mcp/
├── src/
│   ├── worker.ts                 # Hono app — Cloudflare Workers entry
│   ├── stdio.ts                  # STDIO entry for npm (Claude Desktop/Code)
│   ├── env.ts                    # Env type definition (bindings + secrets)
│   │
│   ├── routes/
│   │   ├── mcp.ts                # POST/GET/DELETE /mcp — MCP JSON-RPC
│   │   ├── oauth.ts              # OAuth 2.0 flow — /oauth/authorize, /oauth/token
│   │   ├── discovery.ts          # .well-known/oauth-* endpoints (RFC 9728)
│   │   └── health.ts             # GET /health
│   │
│   ├── mcp/
│   │   ├── handler.ts            # MCP method dispatcher (initialize, tools/list, tools/call)
│   │   ├── session.ts            # KV-backed session management
│   │   └── protocol.ts           # JSON-RPC helpers, protocol version negotiation
│   │
│   ├── oauth/
│   │   ├── server.ts             # OAuth authorization server (KV-backed)
│   │   ├── tokens.ts             # Token generation, validation, revocation (KV)
│   │   └── pkce.ts               # PKCE S256 challenge verification
│   │
│   ├── tools/
│   │   ├── index.ts              # Tool registry — exports all tools as typed array
│   │   ├── types.ts              # ToolDefinition interface, ToolContext type
│   │   ├── web-search.ts         # web_search tool
│   │   ├── reddit-search.ts      # search_reddit tool
│   │   ├── reddit-post.ts        # get_reddit_post tool
│   │   ├── scrape.ts             # scrape_links tool
│   │   ├── deep-research.ts      # deep_research tool
│   │   ├── news.ts               # search_news tool
│   │   ├── hackernews.ts         # search_hackernews tool
│   │   └── x-search.ts           # search_x tool
│   │
│   ├── clients/
│   │   ├── serper.ts             # Google Serper API client
│   │   ├── reddit.ts             # Reddit OAuth + API client
│   │   ├── scraper.ts            # Scrape.do client (3-mode fallback)
│   │   ├── openrouter.ts         # OpenRouter LLM client (research + extraction)
│   │   └── hackernews.ts         # Hacker News Algolia client
│   │
│   ├── lib/
│   │   ├── concurrency.ts        # pMap, pMapSettled (bounded parallelism)
│   │   ├── errors.ts             # Error classification (StructuredError)
│   │   ├── response.ts           # 70/20/10 response formatting
│   │   ├── url-ranking.ts        # CTR-weighted URL aggregation
│   │   ├── markdown.ts           # HTML → Markdown (Turndown)
│   │   ├── timeout.ts            # withRequestTimeout, withStallProtection
│   │   └── id.ts                 # UUID/random ID generation
│   │
│   └── schemas/
│       ├── web-search.ts         # Zod schema for web_search
│       ├── reddit.ts             # Zod schemas for reddit tools
│       ├── scrape.ts             # Zod schema for scrape_links
│       ├── deep-research.ts      # Zod schema for deep_research
│       ├── news.ts               # Zod schema for search_news
│       ├── hackernews.ts         # Zod schema for search_hackernews
│       └── x-search.ts           # Zod schema for search_x
│
├── wrangler.toml                 # Cloudflare Workers config (replaces wrangler.jsonc)
├── tsconfig.json                 # TypeScript config (updated for Workers)
├── package.json                  # Updated deps + scripts
├── .env.example                  # Environment variable reference
├── CLAUDE.md                     # Updated for new architecture
└── README.md                     # Updated docs
```

**Deleted directories/files:**
```
src/config/           ← Entire directory (YAML loader, lazy proxies)
src/services/         ← Entire directory (usage tracker, llm-processor → moved to clients/)
src/auth.ts           ← Replaced by src/oauth/
src/index.ts          ← Replaced by src/worker.ts + src/stdio.ts
src/version.ts        ← Use package.json import or env var
railway.toml          ← No more Railway
Dockerfile            ← If exists
wrangler.jsonc        ← Replaced by wrangler.toml
```

---

## 4. Phase 1: Project Setup & Wrangler Config

### 4.1 `wrangler.toml`

```toml
name = "research-mcp"
main = "src/worker.ts"
compatibility_date = "2026-03-01"
compatibility_flags = ["nodejs_compat"]

# KV Namespaces
[[kv_namespaces]]
binding = "OAUTH_TOKENS"
id = "<OAUTH_TOKENS_KV_ID>"

[[kv_namespaces]]
binding = "MCP_SESSIONS"
id = "<MCP_SESSIONS_KV_ID>"

# Observability (replaces custom usage tracker)
[observability]
enabled = true

# Public vars
[vars]
SERVER_NAME = "research-mcp"
SERVER_VERSION = "5.0.0"
MCP_PROTOCOL_VERSION = "2025-11-25"
SESSION_TTL_SECONDS = "1800"
MAX_SESSIONS = "100"
DEFAULT_REASONING_EFFORT = "high"
DEFAULT_MAX_URLS = "100"
API_TIMEOUT_MS = "300000"

# Custom domain
[[routes]]
pattern = "research.pragmaticgrowth.com"
custom_domain = true

# Dev
[env.dev]
name = "research-mcp-dev"
```

**No Durable Objects.** KV is sufficient for OAuth tokens (30-day TTL) and MCP sessions (30-min TTL). Durable Objects add complexity without benefit here.

### 4.2 `package.json` Updates

```json
{
  "name": "research-mcp",
  "version": "5.0.0",
  "type": "module",
  "main": "dist/stdio.js",
  "bin": {
    "research-mcp": "dist/stdio.js",
    "research-mcp-mcp": "dist/stdio.js"
  },
  "scripts": {
    "dev": "wrangler dev",
    "dev:stdio": "tsx src/stdio.ts",
    "deploy": "wrangler deploy",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "start": "node dist/stdio.js"
  },
  "dependencies": {
    "hono": "^4.11.9",
    "@modelcontextprotocol/sdk": "^1.26.0",
    "openai": "^4.77.0",
    "zod": "^3.24.1",
    "turndown": "^7.2.2"
  },
  "devDependencies": {
    "wrangler": "latest",
    "@cloudflare/workers-types": "latest",
    "typescript": "^5.6.0",
    "tsx": "^4.19.0"
  }
}
```

**Removed:**
- `yaml` — no YAML loading
- `zod-to-json-schema` — use Zod's built-in `zodToJsonSchema` or manual schema
- `agents` — no Durable Objects McpAgent
- `@types/node` — use `@cloudflare/workers-types`

### 4.3 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Note:** Both `worker.ts` and `stdio.ts` are included. Wrangler bundles `worker.ts` separately — the `dist/` output is for the npm package (`stdio.ts` entry).

### 4.4 `src/env.ts` — Worker Bindings Type

```typescript
export interface Env {
  // KV Namespaces
  OAUTH_TOKENS: KVNamespace;
  MCP_SESSIONS: KVNamespace;

  // Server config
  SERVER_NAME: string;
  SERVER_VERSION: string;
  MCP_PROTOCOL_VERSION: string;
  SESSION_TTL_SECONDS: string;
  MAX_SESSIONS: string;

  // API Keys (secrets — set via `wrangler secret put`)
  SERPER_API_KEY?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  SCRAPEDO_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;

  // OAuth (secrets)
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;

  // AI Model config (vars or secrets)
  RESEARCH_MODEL?: string;
  RESEARCH_FALLBACK_MODEL?: string;
  LLM_EXTRACTION_MODEL?: string;

  // Tuning
  DEFAULT_REASONING_EFFORT?: string;
  DEFAULT_MAX_URLS?: string;
  API_TIMEOUT_MS?: string;
}

/**
 * Capabilities derived from which API keys are present.
 * Computed once per request from env bindings.
 */
export interface Capabilities {
  search: boolean;       // SERPER_API_KEY present
  reddit: boolean;       // REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET present
  scraping: boolean;     // SCRAPEDO_API_KEY present
  deepResearch: boolean; // OPENROUTER_API_KEY present
  xSearch: boolean;      // OPENROUTER_API_KEY present
  llmExtraction: boolean; // OPENROUTER_API_KEY present
}

export function getCapabilities(env: Env): Capabilities {
  return {
    search: !!env.SERPER_API_KEY,
    reddit: !!env.REDDIT_CLIENT_ID && !!env.REDDIT_CLIENT_SECRET,
    scraping: !!env.SCRAPEDO_API_KEY,
    deepResearch: !!env.OPENROUTER_API_KEY,
    xSearch: !!env.OPENROUTER_API_KEY,
    llmExtraction: !!env.OPENROUTER_API_KEY,
  };
}
```

**Key design**: `getCapabilities()` is a pure function that takes `env`. No caching, no global state, no Proxy. Workers requests are isolated — compute capabilities fresh each time.

---

## 5. Phase 2: Hono App Entry Point

### 5.1 `src/worker.ts`

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './env.js';

import { healthRoutes } from './routes/health.js';
import { mcpRoutes } from './routes/mcp.js';
import { oauthRoutes } from './routes/oauth.js';
import { discoveryRoutes } from './routes/discovery.js';

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Routes
app.route('/', discoveryRoutes);        // .well-known/* (must be first)
app.route('/oauth', oauthRoutes);       // /oauth/authorize, /oauth/token
app.route('/mcp', mcpRoutes);           // POST/GET/DELETE /mcp
app.route('/', healthRoutes);           // /health

// Root
app.get('/', (c) => c.json({
  name: c.env.SERVER_NAME,
  version: c.env.SERVER_VERSION,
  protocol: c.env.MCP_PROTOCOL_VERSION,
  transport: 'streamable-http',
  docs: 'https://github.com/anthropics/research-mcp',
}));

// 404
app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err.message, err.stack);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
```

That's it. No `process.env` bridging. No `bridgeEnv()`. No `serve()`. Just `export default app`.

---

## 6. Phase 3: OAuth for Claude.ai (Critical)

This is the most important phase. Without this, claude.ai cannot connect to the MCP server.

### 6.1 How Claude.ai Custom Connectors Work

```
claude.ai user clicks "Add MCP Server"
        │
        ▼
GET /.well-known/oauth-protected-resource
        │ Returns: { resource, authorization_servers: [...] }
        ▼
GET /.well-known/oauth-authorization-server
        │ Returns: { authorization_endpoint, token_endpoint, ... }
        ▼
GET /oauth/authorize?client_id=...&redirect_uri=...&code_challenge=...&state=...
        │ Returns: HTML approval page (or auto-approve for trusted clients)
        ▼
POST /oauth/authorize (user clicks "Approve")
        │ Redirects to callback with ?code=...&state=...
        ▼
POST /oauth/token  { grant_type: authorization_code, code: ..., code_verifier: ... }
        │ Returns: { access_token, token_type: bearer, expires_in }
        ▼
POST /mcp  (Authorization: Bearer <token>)
        │ MCP JSON-RPC requests with valid token
```

### 6.2 OAuth Discovery Endpoints

```typescript
// src/routes/discovery.ts
import { Hono } from 'hono';
import type { Env } from '../env.js';

export const discoveryRoutes = new Hono<{ Bindings: Env }>();

// RFC 9728: OAuth Protected Resource Metadata
discoveryRoutes.get('/.well-known/oauth-protected-resource', (c) => {
  const baseUrl = getBaseUrl(c);
  return c.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
  });
});

// RFC 8414: OAuth Authorization Server Metadata
discoveryRoutes.get('/.well-known/oauth-authorization-server', (c) => {
  const baseUrl = getBaseUrl(c);
  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:tools'],
  });
});

// Dynamic client registration (RFC 7591) — required by MCP spec
discoveryRoutes.post('/.well-known/oauth-authorization-server/register',
  async (c) => {
    // Accept any client registration and return a client_id
    // This is simplified — MCP spec allows open registration
    const body = await c.req.json();
    const clientId = crypto.randomUUID();

    // Store client info in KV
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

    return c.json({
      client_id: clientId,
      client_name: body.client_name || 'MCP Client',
      redirect_uris: body.redirect_uris || [],
    }, 201);
  }
);

function getBaseUrl(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}
```

### 6.3 OAuth Authorization & Token Endpoints

```typescript
// src/routes/oauth.ts
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { verifyPKCE, generateToken } from '../oauth/pkce.js';

export const oauthRoutes = new Hono<{ Bindings: Env }>();

// GET /oauth/authorize — Show approval page
oauthRoutes.get('/authorize', async (c) => {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } =
    c.req.query();

  if (!client_id || !redirect_uri || !code_challenge) {
    return c.json({ error: 'invalid_request', error_description: 'Missing required parameters' }, 400);
  }

  if (code_challenge_method && code_challenge_method !== 'S256') {
    return c.json({ error: 'invalid_request', error_description: 'Only S256 supported' }, 400);
  }

  // Auto-approve: for an MCP server you own, you can skip the consent screen.
  // Store auth code and redirect immediately.
  const code = crypto.randomUUID();

  await c.env.OAUTH_TOKENS.put(
    `code:${code}`,
    JSON.stringify({
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method: code_challenge_method || 'S256',
      scope: scope || 'mcp:tools',
      created_at: Date.now(),
    }),
    { expirationTtl: 600 } // 10 minute expiry for auth codes
  );

  // Redirect back with code
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  return c.redirect(redirectUrl.toString(), 302);
});

// POST /oauth/authorize — For form-based approval (if you want a consent screen)
oauthRoutes.post('/authorize', async (c) => {
  // Same logic as GET but from form body
  const body = await c.req.parseBody();
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = body as Record<string, string>;

  if (!client_id || !redirect_uri || !code_challenge) {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const code = crypto.randomUUID();

  await c.env.OAUTH_TOKENS.put(
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

  return c.redirect(redirectUrl.toString(), 302);
});

// POST /oauth/token — Exchange code for access token
oauthRoutes.post('/token', async (c) => {
  const body = await c.req.parseBody();
  const { grant_type, code, code_verifier, client_id, redirect_uri } = body as Record<string, string>;

  if (grant_type !== 'authorization_code') {
    return c.json({ error: 'unsupported_grant_type' }, 400);
  }

  if (!code || !code_verifier) {
    return c.json({ error: 'invalid_request', error_description: 'Missing code or code_verifier' }, 400);
  }

  // Retrieve stored auth code
  const storedRaw = await c.env.OAUTH_TOKENS.get(`code:${code}`, 'json') as {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    scope: string;
  } | null;

  if (!storedRaw) {
    return c.json({ error: 'invalid_grant', error_description: 'Code expired or invalid' }, 400);
  }

  // Delete code immediately (one-time use)
  await c.env.OAUTH_TOKENS.delete(`code:${code}`);

  // Verify PKCE
  const pkceValid = await verifyPKCE(code_verifier, storedRaw.code_challenge);
  if (!pkceValid) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
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
```

### 6.4 PKCE Utilities

```typescript
// src/oauth/pkce.ts

/**
 * Verify PKCE S256 challenge.
 * code_challenge = BASE64URL(SHA256(code_verifier))
 */
export async function verifyPKCE(
  codeVerifier: string,
  codeChallenge: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return base64url === codeChallenge;
}

/**
 * Generate a cryptographically secure token.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
```

All using Web Crypto API — native to Workers, no npm packages needed.

### 6.5 OAuth Middleware for MCP Routes

```typescript
// src/middleware/auth.ts
import type { Context, Next } from 'hono';
import type { Env } from '../env.js';

/**
 * Validates Bearer token from Authorization header.
 * Used on /mcp routes to authenticate claude.ai connections.
 */
export async function requireOAuth(
  c: Context<{ Bindings: Env; Variables: { authenticated: boolean } }>,
  next: Next
) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing or invalid Authorization header' },
      id: null,
    }, 401);
  }

  const token = authHeader.slice(7);
  const stored = await c.env.OAUTH_TOKENS.get(`token:${token}`);

  if (!stored) {
    return c.json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Invalid or expired token' },
      id: null,
    }, 401);
  }

  c.set('authenticated', true);
  return next();
}
```

### 6.6 Dynamic Client Registration

The MCP spec (2025-11-25) requires OAuth servers to support dynamic client registration (RFC 7591). This is handled in the discovery routes (section 6.2) via `POST /.well-known/oauth-authorization-server/register`.

Claude.ai will call this endpoint to register itself as an OAuth client before starting the authorization flow. The registration endpoint accepts any client and returns a `client_id` — this is standard for personal MCP servers where you trust all connecting clients.

---

## 7. Phase 4: MCP Protocol Handler

### 7.1 MCP Routes

```typescript
// src/routes/mcp.ts
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireOAuth } from '../middleware/auth.js';
import { handleMcpRequest } from '../mcp/handler.js';
import { createSession, getSession, touchSession, deleteSession } from '../mcp/session.js';

export const mcpRoutes = new Hono<{
  Bindings: Env;
  Variables: { authenticated: boolean };
}>();

// Auth on all MCP routes
mcpRoutes.use('*', requireOAuth);

// POST /mcp — Main JSON-RPC handler
mcpRoutes.post('/', async (c) => {
  const body = await c.req.json();
  const sessionId = c.req.header('mcp-session-id');

  const result = await handleMcpRequest(body, sessionId, c.env);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // If initialize, return new session ID
  if (result.sessionId) {
    headers['mcp-session-id'] = result.sessionId;
  }

  return c.json(result.body, { status: 200, headers });
});

// GET /mcp — Session info / SSE reconnect
mcpRoutes.get('/', async (c) => {
  const sessionId = c.req.header('mcp-session-id');
  if (!sessionId) {
    return c.json({ error: 'Missing mcp-session-id header' }, 400);
  }

  const session = await getSession(c.env.MCP_SESSIONS, sessionId);
  if (!session) {
    return c.json({ error: 'Session not found or expired' }, 404);
  }

  return c.json({
    sessionId,
    active: true,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    protocolVersion: session.protocolVersion,
  });
});

// DELETE /mcp — Terminate session
mcpRoutes.delete('/', async (c) => {
  const sessionId = c.req.header('mcp-session-id');
  if (sessionId) {
    await deleteSession(c.env.MCP_SESSIONS, sessionId);
  }
  return c.json({ success: true });
});
```

### 7.2 MCP Handler (Method Dispatcher)

```typescript
// src/mcp/handler.ts
import type { Env } from '../env.js';
import { getCapabilities } from '../env.js';
import { createSession, getSession, touchSession } from './session.js';
import { jsonRpcResponse, jsonRpcError } from './protocol.js';
import { getAllTools, executeTool } from '../tools/index.js';

interface McpResult {
  body: unknown;
  sessionId?: string;
}

export async function handleMcpRequest(
  body: { jsonrpc: string; method: string; params?: Record<string, unknown>; id?: string | number },
  sessionId: string | undefined,
  env: Env
): Promise<McpResult> {
  const { method, params, id } = body;

  switch (method) {
    case 'initialize': {
      const newSessionId = crypto.randomUUID();
      await createSession(env.MCP_SESSIONS, newSessionId, {
        protocolVersion: (params?.protocolVersion as string) || env.MCP_PROTOCOL_VERSION,
      });

      return {
        sessionId: newSessionId,
        body: jsonRpcResponse(id, {
          protocolVersion: env.MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: env.SERVER_NAME,
            version: env.SERVER_VERSION,
          },
        }),
      };
    }

    case 'notifications/initialized': {
      // Client acknowledges initialization — no response needed for notifications
      if (sessionId) await touchSession(env.MCP_SESSIONS, sessionId);
      return { body: null }; // Notifications have no response
    }

    case 'tools/list': {
      if (sessionId) await touchSession(env.MCP_SESSIONS, sessionId);
      const capabilities = getCapabilities(env);
      const tools = getAllTools(capabilities);

      return {
        body: jsonRpcResponse(id, { tools }),
      };
    }

    case 'tools/call': {
      if (sessionId) await touchSession(env.MCP_SESSIONS, sessionId);
      const capabilities = getCapabilities(env);
      const toolName = params?.name as string;
      const toolArgs = params?.arguments as Record<string, unknown> || {};

      try {
        const result = await executeTool(toolName, toolArgs, capabilities, env);
        return { body: jsonRpcResponse(id, result) };
      } catch (error) {
        return {
          body: jsonRpcResponse(id, {
            content: [{
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
          }),
        };
      }
    }

    case 'ping': {
      if (sessionId) await touchSession(env.MCP_SESSIONS, sessionId);
      return { body: jsonRpcResponse(id, {}) };
    }

    default: {
      return {
        body: jsonRpcError(id, -32601, `Method not found: ${method}`),
      };
    }
  }
}
```

### 7.3 Session Management (KV-backed)

```typescript
// src/mcp/session.ts

export interface SessionInfo {
  createdAt: string;
  lastActivity: string;
  protocolVersion: string;
}

export async function createSession(
  kv: KVNamespace,
  sessionId: string,
  opts: { protocolVersion: string }
): Promise<void> {
  const now = new Date().toISOString();
  await kv.put(
    `session:${sessionId}`,
    JSON.stringify({
      createdAt: now,
      lastActivity: now,
      protocolVersion: opts.protocolVersion,
    } satisfies SessionInfo),
    { expirationTtl: 1800 } // 30 min TTL, auto-cleaned by KV
  );
}

export async function getSession(
  kv: KVNamespace,
  sessionId: string
): Promise<SessionInfo | null> {
  return kv.get(`session:${sessionId}`, 'json');
}

export async function touchSession(
  kv: KVNamespace,
  sessionId: string
): Promise<void> {
  const session = await getSession(kv, sessionId);
  if (session) {
    session.lastActivity = new Date().toISOString();
    await kv.put(`session:${sessionId}`, JSON.stringify(session), {
      expirationTtl: 1800,
    });
  }
}

export async function deleteSession(
  kv: KVNamespace,
  sessionId: string
): Promise<void> {
  await kv.delete(`session:${sessionId}`);
}
```

**Key advantage over old approach**: KV TTL handles session expiry automatically. No reap interval needed. No in-memory Map that dies on redeploy. No LRU eviction logic.

### 7.4 JSON-RPC Protocol Helpers

```typescript
// src/mcp/protocol.ts

export function jsonRpcResponse(id: string | number | undefined, result: unknown) {
  return {
    jsonrpc: '2.0',
    result,
    id: id ?? null,
  };
}

export function jsonRpcError(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown
) {
  return {
    jsonrpc: '2.0',
    error: { code, message, ...(data ? { data } : {}) },
    id: id ?? null,
  };
}

// MCP standard error codes
export const MCP_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  TOOL_NOT_FOUND: -32002,
  CAPABILITY_MISSING: -32003,
} as const;
```

---

## 8. Phase 5: Tool System

### 8.1 Tool Types

```typescript
// src/tools/types.ts
import type { z } from 'zod';
import type { Env, Capabilities } from '../env.js';

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: TSchema;
  capability?: keyof Capabilities;  // Which capability enables this tool
  handler: (params: z.infer<TSchema>, env: Env) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Convert Zod schema to MCP-compatible JSON Schema.
 * MCP requires { type: "object", properties: {...} } format.
 */
export function zodToInputSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  // Use Zod's built-in JSON Schema conversion or manual mapping
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodTypeAny;
    properties[key] = zodTypeToJsonSchema(zodType);
    if (!zodType.isOptional()) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
```

### 8.2 Tool Registry

```typescript
// src/tools/index.ts
import type { Env, Capabilities } from '../env.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { zodToInputSchema } from './types.js';

// Tool imports
import { webSearchTool } from './web-search.js';
import { redditSearchTool } from './reddit-search.js';
import { redditPostTool } from './reddit-post.js';
import { scrapeTool } from './scrape.js';
import { deepResearchTool } from './deep-research.js';
import { newsTool } from './news.js';
import { hackernewsTool } from './hackernews.js';
import { xSearchTool } from './x-search.js';

const ALL_TOOLS: ToolDefinition[] = [
  webSearchTool,
  redditSearchTool,
  redditPostTool,
  scrapeTool,
  deepResearchTool,
  newsTool,
  hackernewsTool,
  xSearchTool,
];

const toolMap = new Map(ALL_TOOLS.map(t => [t.name, t]));

/**
 * Get tools available for the current capabilities.
 * Returns MCP-formatted tool list.
 */
export function getAllTools(capabilities: Capabilities) {
  return ALL_TOOLS
    .filter(tool => !tool.capability || capabilities[tool.capability])
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToInputSchema(tool.inputSchema),
    }));
}

/**
 * Execute a tool by name.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  capabilities: Capabilities,
  env: Env
): Promise<ToolResult> {
  const tool = toolMap.get(name);

  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Capability check
  if (tool.capability && !capabilities[tool.capability]) {
    return {
      content: [{ type: 'text', text: `Tool "${name}" requires ${tool.capability} capability. Set the required API key.` }],
      isError: true,
    };
  }

  // Validate input
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.message}` }],
      isError: true,
    };
  }

  // Execute
  return tool.handler(parsed.data, env);
}
```

### 8.3 Example Tool Implementation

```typescript
// src/tools/web-search.ts
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { Env } from '../env.js';
import { SerperClient } from '../clients/serper.js';
import { aggregateAndRankUrls } from '../lib/url-ranking.js';
import { formatSuccess } from '../lib/response.js';

const schema = z.object({
  keywords: z.array(z.string()).min(3).max(100)
    .describe('3-100 search keywords. Each becomes a separate Google search.'),
  num_results: z.number().min(5).max(20).optional().default(10)
    .describe('Results per keyword (default 10)'),
});

export const webSearchTool: ToolDefinition<typeof schema> = {
  name: 'web_search',
  description: 'Parallel Google search with 3-100 keywords. Returns CTR-weighted ranked URLs with consensus detection.',
  inputSchema: schema,
  capability: 'search',

  async handler(params, env: Env): Promise<ToolResult> {
    const client = new SerperClient(env.SERPER_API_KEY!);
    const results = await client.searchMultiple(params.keywords, params.num_results);

    const ranked = aggregateAndRankUrls(results, params.keywords);

    const text = formatSuccess({
      title: `Web Search: ${params.keywords.length} keywords`,
      summary: ranked.output,
      metadata: {
        keywords: params.keywords.length,
        uniqueUrls: ranked.totalUniqueUrls,
      },
      nextSteps: [
        'Use `scrape_links` to extract content from top URLs',
        'Use `deep_research` to synthesize findings',
      ],
    });

    return { content: [{ type: 'text', text }] };
  },
};
```

**Pattern**: Every tool is a self-contained file that exports a `ToolDefinition`. The tool receives `env` directly — no global state.

### 8.4 Tool → Client Relationship

Every tool creates its client instance with the env bindings it needs:

```typescript
// In tool handler:
const client = new SerperClient(env.SERPER_API_KEY!);
const client = new RedditClient(env.REDDIT_CLIENT_ID!, env.REDDIT_CLIENT_SECRET!);
const client = new ScraperClient(env.SCRAPEDO_API_KEY!);
const client = new OpenRouterClient(env.OPENROUTER_API_KEY!, {
  model: env.RESEARCH_MODEL,
  fallbackModel: env.RESEARCH_FALLBACK_MODEL,
});
```

No global singletons. No module-level client caches. Workers are ephemeral — create clients per request.

**Exception**: Reddit OAuth token can be cached in KV if latency matters:
```typescript
const client = new RedditClient(env.REDDIT_CLIENT_ID!, env.REDDIT_CLIENT_SECRET!, env.MCP_SESSIONS);
// Uses KV key `reddit:token` with TTL for the OAuth token cache
```

---

## 9. Phase 6: External API Clients

### 9.1 Client Design Pattern

All clients follow this pattern:

```typescript
export class SomeClient {
  constructor(
    private apiKey: string,
    private options?: { timeout?: number }
  ) {}

  async doThing(params: Params): Promise<Result> {
    const response = await fetch(URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(this.options?.timeout ?? 30_000),
    });

    if (!response.ok) {
      throw classifyHttpError(response);
    }

    return response.json();
  }
}
```

**Key principles:**
- Accept API key in constructor (not from `process.env`)
- Use native `fetch` (Workers global)
- Use `AbortSignal.timeout()` for timeouts (Workers native)
- Return typed results
- Throw classified errors

### 9.2 Clients to Rewrite

| Client | Old File | Changes |
|--------|----------|---------|
| `SerperClient` | `clients/search.ts` | Remove `process.env`, accept key in constructor |
| `RedditClient` | `clients/reddit.ts` | Remove module-level token cache → accept optional KV for token caching |
| `ScraperClient` | `clients/scraper.ts` | Same 3-mode fallback, remove `process.env` |
| `OpenRouterClient` | `clients/research.ts` + `services/llm-processor.ts` | **Merge** into single client with `research()` and `extract()` methods |
| `HackerNewsClient` | `clients/hackernews.ts` | Minimal changes (no API key needed) |
| `XSearchClient` | `clients/xsearch.ts` | Remove `process.env`, accept key in constructor |

### 9.3 Merging Research + Extraction

Currently there are two separate LLM integration points:
- `clients/research.ts` → `ResearchClient` (for `deep_research`, `search_x`)
- `services/llm-processor.ts` → `processContentWithLLM()` (for `scrape_links` extraction)

Both call OpenRouter. Merge into one:

```typescript
// src/clients/openrouter.ts
export class OpenRouterClient {
  constructor(
    private apiKey: string,
    private options: {
      baseUrl?: string;
      model?: string;        // Primary model
      fallbackModel?: string; // Fallback model
      extractionModel?: string; // For content extraction
      timeout?: number;
    } = {}
  ) {}

  // For deep_research: web-grounded research with citations
  async research(params: ResearchParams): Promise<ResearchResponse> { ... }

  // For scrape_links: content extraction/summarization
  async extract(content: string, instruction: string): Promise<string> { ... }

  // For search_x: Grok with X search plugin
  async xSearch(query: string, filters?: XSearchFilter): Promise<XSearchResponse> { ... }
}
```

### 9.4 Reddit Token Caching with KV

The Reddit client needs an OAuth token (client credentials grant). Currently cached in a module-level variable with 60s expiry. In Workers (stateless), use KV:

```typescript
// src/clients/reddit.ts
export class RedditClient {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private kv?: KVNamespace // Optional KV for token caching
  ) {}

  private async getToken(): Promise<string> {
    // Check KV cache
    if (this.kv) {
      const cached = await this.kv.get('reddit:oauth_token');
      if (cached) return cached;
    }

    // Fetch new token
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const data = await response.json() as { access_token: string; expires_in: number };

    // Cache in KV (expire 60s before actual expiry)
    if (this.kv) {
      await this.kv.put('reddit:oauth_token', data.access_token, {
        expirationTtl: Math.max(data.expires_in - 60, 60),
      });
    }

    return data.access_token;
  }
}
```

---

## 10. Phase 7: LLM Integration

### 10.1 Model Configuration

Models are **not hardcoded**. They're env vars with defaults applied at the client level:

```typescript
// In OpenRouterClient constructor:
const model = options.model || 'x-ai/grok-4-fast';           // for research
const fallback = options.fallbackModel || 'google/gemini-2.5-flash'; // research fallback
const extraction = options.extractionModel;                    // for scrape extraction (optional)
```

The user sets models via `wrangler.toml` vars or `wrangler secret put`:
```toml
[vars]
RESEARCH_MODEL = "x-ai/grok-4-fast"
RESEARCH_FALLBACK_MODEL = "google/gemini-2.5-flash"
LLM_EXTRACTION_MODEL = "openai/gpt-oss-120b:nitro"
```

**No Llama models. No Workers AI for LLM.** Models chosen at deploy time, not in code.

### 10.2 Model Fallback Pattern

```typescript
async research(params: ResearchParams): Promise<ResearchResponse> {
  try {
    return await this.executeResearch(this.model, params);
  } catch (primaryError) {
    if (!this.fallbackModel || !isRetryableError(primaryError)) throw primaryError;
    console.warn(`Primary model failed, trying fallback: ${this.fallbackModel}`);
    return await this.executeResearch(this.fallbackModel, params);
  }
}
```

### 10.3 Gemini Special Handling (Preserve)

Keep the current pattern for Gemini models — they use `tools: [{type: 'google_search'}]` instead of OpenRouter's `search_parameters`:

```typescript
private buildRequestBody(model: string, messages: Message[], options: RequestOptions) {
  const body: Record<string, unknown> = { model, messages };

  if (isGeminiModel(model)) {
    body.tools = [{ type: 'google_search', googleSearch: {} }];
  } else {
    body.search_parameters = {
      mode: 'on',
      max_search_results: options.maxSearchResults ?? 100,
      return_citations: true,
    };
  }

  return body;
}

function isGeminiModel(model: string): boolean {
  return model.startsWith('google/gemini');
}
```

---

## 11. Phase 8: STDIO Entry Point (npm package)

The npm package (`npx research-mcp`) needs a Node.js STDIO entry that shares the same tool logic.

### 11.1 `src/stdio.ts`

```typescript
#!/usr/bin/env node
/**
 * STDIO entry point for Claude Desktop / Claude Code.
 * Shares tool definitions and handlers with the Workers entry.
 * Reads env from process.env (standard for STDIO MCP servers).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getAllTools, executeTool } from './tools/index.js';
import type { Env } from './env.js';

// Build Env-like object from process.env for STDIO mode
function buildEnvFromProcessEnv(): Env {
  return {
    // KV not available in STDIO — tools that need KV will gracefully degrade
    OAUTH_TOKENS: null as unknown as KVNamespace,
    MCP_SESSIONS: null as unknown as KVNamespace,

    SERVER_NAME: 'research-mcp',
    SERVER_VERSION: process.env.npm_package_version || '5.0.0',
    MCP_PROTOCOL_VERSION: '2025-11-25',
    SESSION_TTL_SECONDS: '1800',
    MAX_SESSIONS: '100',

    // API keys from process.env
    SERPER_API_KEY: process.env.SERPER_API_KEY,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
    SCRAPEDO_API_KEY: process.env.SCRAPEDO_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,

    OAUTH_CLIENT_ID: '',
    OAUTH_CLIENT_SECRET: '',

    RESEARCH_MODEL: process.env.RESEARCH_MODEL,
    RESEARCH_FALLBACK_MODEL: process.env.RESEARCH_FALLBACK_MODEL,
    LLM_EXTRACTION_MODEL: process.env.LLM_EXTRACTION_MODEL,
    DEFAULT_REASONING_EFFORT: process.env.DEFAULT_REASONING_EFFORT,
    DEFAULT_MAX_URLS: process.env.DEFAULT_MAX_URLS,
    API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
  };
}

async function main() {
  const env = buildEnvFromProcessEnv();
  const { getCapabilities } = await import('./env.js');
  const capabilities = getCapabilities(env);

  const server = new Server(
    { name: env.SERVER_NAME, version: env.SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllTools(capabilities),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return executeTool(name, args || {}, capabilities, env);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.on('end', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

**Key**: STDIO and Workers share the same `tools/`, `clients/`, `lib/`, `schemas/` code. The only difference is how `Env` is constructed and how the transport works.

### 11.2 Build for npm

The `tsc` build produces `dist/` with:
- `dist/stdio.js` — STDIO entry (npm binary)
- `dist/tools/`, `dist/clients/`, `dist/lib/`, `dist/schemas/` — shared code

Wrangler separately bundles `src/worker.ts` for Workers deployment (it does its own bundling, ignores `dist/`).

---

## 12. Phase 9: Deployment & Secrets

### 12.1 Initial Setup

```bash
# Login to Cloudflare
wrangler login

# Create KV namespaces
wrangler kv namespace create OAUTH_TOKENS
wrangler kv namespace create MCP_SESSIONS

# Update wrangler.toml with the IDs from above

# Set secrets
wrangler secret put SERPER_API_KEY
wrangler secret put REDDIT_CLIENT_ID
wrangler secret put REDDIT_CLIENT_SECRET
wrangler secret put SCRAPEDO_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put OAUTH_CLIENT_ID
wrangler secret put OAUTH_CLIENT_SECRET

# Deploy
wrangler deploy
```

### 12.2 Custom Domain

```toml
# In wrangler.toml:
[[routes]]
pattern = "research.pragmaticgrowth.com"
custom_domain = true
```

Or use the default Workers URL: `research-mcp.<account>.workers.dev`

### 12.3 Connecting to Claude.ai

1. Deploy the Worker
2. Go to claude.ai → Settings → Integrations → Add MCP Server
3. Enter the Worker URL: `https://research.pragmaticgrowth.com/mcp`
4. Claude.ai will discover OAuth endpoints, register a client, and start the auth flow
5. After authorization, Claude.ai stores the access token and includes it in all MCP requests

### 12.4 GitHub Actions (Updated)

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy-worker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}

  publish-npm:
    runs-on: ubuntu-latest
    needs: deploy-worker  # Deploy worker first, then publish npm
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'pnpm', registry-url: 'https://registry.npmjs.org' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: npm publish --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## 13. Environment & Bindings Reference

### KV Bindings (wrangler.toml)
| Binding | Purpose | Key Patterns |
|---------|---------|-------------|
| `OAUTH_TOKENS` | OAuth codes, tokens, client registrations | `code:{uuid}` (10min TTL), `token:{hex}` (30d TTL), `client:{uuid}` (1y TTL) |
| `MCP_SESSIONS` | MCP session state | `session:{uuid}` (30min TTL), `reddit:oauth_token` (token TTL) |

### Secrets (`wrangler secret put`)
| Secret | Required | Enables |
|--------|----------|---------|
| `SERPER_API_KEY` | No | web_search, search_reddit, search_news |
| `REDDIT_CLIENT_ID` | No | get_reddit_post |
| `REDDIT_CLIENT_SECRET` | No | get_reddit_post |
| `SCRAPEDO_API_KEY` | No | scrape_links |
| `OPENROUTER_API_KEY` | No | deep_research, search_x, LLM extraction |
| `OAUTH_CLIENT_ID` | Yes | OAuth for claude.ai |
| `OAUTH_CLIENT_SECRET` | Yes | OAuth for claude.ai |

### Vars (wrangler.toml `[vars]`)
| Variable | Default | Purpose |
|---------|---------|---------|
| `SERVER_NAME` | `research-mcp` | MCP server name |
| `SERVER_VERSION` | `5.0.0` | MCP server version |
| `MCP_PROTOCOL_VERSION` | `2025-11-25` | MCP protocol version |
| `SESSION_TTL_SECONDS` | `1800` | MCP session idle timeout |
| `MAX_SESSIONS` | `100` | Not enforced by KV (KV handles at scale) |
| `RESEARCH_MODEL` | — | Primary research LLM (via OpenRouter) |
| `RESEARCH_FALLBACK_MODEL` | — | Fallback research LLM |
| `LLM_EXTRACTION_MODEL` | — | Content extraction LLM |
| `DEFAULT_REASONING_EFFORT` | `high` | `low\|medium\|high` |
| `DEFAULT_MAX_URLS` | `100` | Max URLs per research question |
| `API_TIMEOUT_MS` | `300000` | External API timeout (5 min) |

---

## 14. File-by-File: Delete / Create / Keep

### DELETE (remove entirely)
```
src/index.ts                    # Replaced by worker.ts + stdio.ts
src/worker.ts                   # Rewritten from scratch
src/auth.ts                     # Replaced by src/oauth/
src/version.ts                  # Inline version or read from env
src/config/                     # Entire directory
  ├── index.ts                  # Lazy Proxy, resetEnvCache — killed
  ├── loader.ts                 # YAML readFileSync — killed
  ├── types.ts                  # Replaced by env.ts
  └── yaml/tools.yaml           # Tools now in TypeScript
src/services/
  ├── usage-tracker.ts          # Killed — use Cloudflare observability
  ├── llm-processor.ts          # Merged into clients/openrouter.ts
  └── file-attachment.ts        # Not available in Workers (no filesystem)
src/tools/definitions.ts        # Replaced by TypeScript tool definitions
src/tools/utils.ts              # Merge into lib/ where needed
railway.toml                    # No more Railway
wrangler.jsonc                  # Replaced by wrangler.toml
AGENTS.md                       # Update or remove
```

### CREATE (new files)
```
src/worker.ts                   # Hono Workers entry (new)
src/stdio.ts                    # STDIO npm entry (new)
src/env.ts                      # Env types + getCapabilities()
src/routes/
  ├── mcp.ts                    # MCP JSON-RPC routes
  ├── oauth.ts                  # OAuth routes
  ├── discovery.ts              # .well-known endpoints
  └── health.ts                 # Health check
src/mcp/
  ├── handler.ts                # MCP method dispatcher
  ├── session.ts                # KV-backed sessions
  └── protocol.ts               # JSON-RPC helpers
src/oauth/
  ├── pkce.ts                   # PKCE S256 verification
  └── tokens.ts                 # Token generation (if not inline in routes)
src/tools/
  ├── index.ts                  # Registry (new pattern)
  ├── types.ts                  # ToolDefinition interface
  ├── web-search.ts             # (rewritten, self-contained)
  ├── reddit-search.ts          # (split from old reddit.ts)
  ├── reddit-post.ts            # (split from old reddit.ts)
  ├── scrape.ts                 # (rewritten)
  ├── deep-research.ts          # (rewritten)
  ├── news.ts                   # (rewritten)
  ├── hackernews.ts             # (rewritten)
  └── x-search.ts               # (rewritten)
src/clients/
  └── openrouter.ts             # Unified LLM client (new, merges research.ts + llm-processor.ts)
src/schemas/
  ├── reddit.ts                 # (new — split/consolidate)
  ├── news.ts                   # (new)
  ├── hackernews.ts             # (new)
  └── x-search.ts               # (new)
src/lib/
  ├── timeout.ts                # withRequestTimeout, withStallProtection (extracted)
  └── id.ts                     # UUID generation helpers
wrangler.toml                   # New config (replaces wrangler.jsonc)
```

### REWRITE (same purpose, new implementation)
```
src/clients/serper.ts           # Accept key in constructor, no process.env
src/clients/reddit.ts           # Accept keys in constructor, KV token cache
src/clients/scraper.ts          # Accept key in constructor, keep 3-mode fallback
src/clients/hackernews.ts       # Minimal changes
src/tools/registry.ts           # Becomes src/tools/index.ts (simplified)
```

### KEEP (move to `src/lib/`, minimal changes)
```
src/utils/concurrency.ts        → src/lib/concurrency.ts    # pMap, pMapSettled
src/utils/errors.ts             → src/lib/errors.ts         # StructuredError, classifyError
src/utils/response.ts           → src/lib/response.ts       # formatSuccess, formatError
src/utils/url-aggregator.ts     → src/lib/url-ranking.ts    # CTR ranking
src/utils/markdown-formatter.ts → src/lib/markdown.ts        # Merge with markdown-cleaner
src/services/markdown-cleaner.ts → src/lib/markdown.ts       # Merge Turndown + formatter
```

---

## 15. Patterns to Preserve

These patterns from the current codebase are good and should survive the refactor:

| Pattern | Where | Why |
|---------|-------|-----|
| **pMap / pMapSettled** | `lib/concurrency.ts` | Bounded parallelism is essential for rate limiting |
| **CTR-weighted URL ranking** | `lib/url-ranking.ts` | Core value proposition of web_search |
| **Smart Reddit comment budget** | `tools/reddit-post.ts` | 1000 total, 200 max/post, redistribution |
| **3-mode scraper fallback** | `clients/scraper.ts` | basic → JS → JS+geo |
| **StructuredError + classifyError** | `lib/errors.ts` | Never-throw, graceful degradation |
| **70/20/10 response format** | `lib/response.ts` | Consistent tool output |
| **Model fallback** | `clients/openrouter.ts` | Primary → fallback on failure |
| **Gemini special handling** | `clients/openrouter.ts` | Different search tool format |
| **Capability-based degradation** | `tools/index.ts` | Missing keys = disabled tools, not errors |
| **Zod validation** | `schemas/*.ts` | Type-safe input validation |
| **AbortSignal timeout** | `lib/timeout.ts` | Request timeout + stall protection |

---

## 16. Patterns to Kill

| Old Pattern | Why It's Bad | Replacement |
|-------------|-------------|-------------|
| `process.env` everywhere | Not available in Workers | `env` parameter from Hono context |
| Lazy Proxy config | Hack for deferred env reads | Direct env access via `c.env` |
| `resetEnvCache()` | Exists only because of Proxy hack | Not needed |
| YAML tool definitions | `readFileSync` breaks Workers | TypeScript constants |
| File-based token storage | No filesystem in Workers | KV |
| File-based usage tracking | No filesystem in Workers | Cloudflare observability |
| In-memory session Map | Lost on redeploy, LRU complexity | KV with TTL |
| Dual entry point | `index.ts` does STDIO+HTTP, `worker.ts` is a shim | Clean separation: `worker.ts` (HTTP) + `stdio.ts` (STDIO) |
| `bridgeEnv()` | Manual key-by-key process.env population | Hono bindings |
| Module-level singletons | Reddit token, pool, config caches | Per-request construction or KV |
| `agents` package McpAgent | Durable Objects overhead for simple sessions | Hono + KV |
| `@hono/node-server` | Node.js adapter (not needed for Workers) | Workers native export |
| `readFileSync` | Node.js only | Eliminated |

---

## 17. Testing Checklist

### OAuth Flow (Critical)
- [ ] `GET /.well-known/oauth-protected-resource` returns correct metadata
- [ ] `GET /.well-known/oauth-authorization-server` returns correct metadata
- [ ] `POST /.well-known/oauth-authorization-server/register` creates client
- [ ] `GET /oauth/authorize` creates code and redirects
- [ ] `POST /oauth/token` exchanges code for token (PKCE verified)
- [ ] `POST /oauth/revoke` invalidates token
- [ ] Auth code expires after 10 minutes
- [ ] Used auth code cannot be reused
- [ ] Invalid PKCE verifier is rejected
- [ ] Bearer token authenticates MCP requests
- [ ] Expired token returns 401
- [ ] Missing token returns 401

### MCP Protocol
- [ ] `POST /mcp` with `initialize` creates session, returns session ID in header
- [ ] `POST /mcp` with `tools/list` returns available tools (filtered by capabilities)
- [ ] `POST /mcp` with `tools/call` executes tool and returns result
- [ ] `POST /mcp` with `ping` returns success
- [ ] `GET /mcp` with session ID returns session info
- [ ] `DELETE /mcp` with session ID deletes session
- [ ] Session TTL is refreshed on activity
- [ ] Unknown method returns -32601 error

### Tools (each tool)
- [ ] web_search: 3+ keywords return ranked URLs
- [ ] search_reddit: queries return Reddit results
- [ ] get_reddit_post: URLs return posts with comments
- [ ] scrape_links: URLs return extracted content
- [ ] deep_research: questions return synthesized research
- [ ] search_news: queries return news results
- [ ] search_hackernews: queries return HN results
- [ ] search_x: queries return X/Twitter results

### Capability Degradation
- [ ] Missing SERPER_API_KEY → web_search/search_reddit/search_news excluded from tools/list
- [ ] Missing REDDIT_CLIENT_ID → get_reddit_post excluded
- [ ] Missing OPENROUTER_API_KEY → deep_research/search_x excluded
- [ ] Tools with missing capability return helpful error if called directly

### Claude.ai Integration (End-to-End)
- [ ] Add MCP server in claude.ai with Worker URL
- [ ] OAuth flow completes successfully
- [ ] Tools appear in claude.ai tool list
- [ ] Tool execution works from claude.ai conversation
- [ ] Token persists across conversations (30-day TTL)

### STDIO (npm package)
- [ ] `npx research-mcp` starts without errors
- [ ] Tools list works
- [ ] Tool execution works
- [ ] Graceful shutdown on stdin close

---

## 18. Workers Compatibility Notes

### Packages That Work
| Package | Status | Notes |
|---------|--------|-------|
| `hono` | Works | First-class Workers support |
| `openai` | Works | Uses `fetch` internally |
| `zod` | Works | Pure TypeScript |
| `turndown` | Works | Pure JavaScript (DOM → Markdown) |
| `@modelcontextprotocol/sdk` | Partial | STDIO transport needs Node.js; server types work |

### APIs Available in Workers
| API | Status |
|-----|--------|
| `fetch()` | Native global |
| `crypto.randomUUID()` | Native |
| `crypto.subtle.*` | Native (Web Crypto) |
| `AbortSignal.timeout()` | Native |
| `TextEncoder/TextDecoder` | Native |
| `URL/URLSearchParams` | Native |
| `btoa/atob` | Native |
| `console.log/warn/error` | Captured by Cloudflare observability |
| `setTimeout` | Available with `nodejs_compat` |

### APIs NOT Available
| API | Workaround |
|-----|-----------|
| `process.env` | Use Hono `c.env` bindings |
| `fs.readFileSync` | Eliminate YAML, use TypeScript |
| `path.join/resolve` | Not needed |
| `child_process` | Not needed |
| `net/tls` | Use `fetch` |
| `os` | Not needed |

### Workers Limits (Paid Plan — $5/month)
| Limit | Value | Impact |
|-------|-------|--------|
| CPU time | 30s per request | Sufficient — most time is I/O (fetch calls) |
| Wall clock | ~15 min | Sufficient for deep_research (multiple LLM calls) |
| Memory | 128MB | Sufficient |
| KV reads | 100k/day (free), unlimited (paid) | Sufficient |
| KV writes | 1k/day (free), unlimited (paid) | Need paid for OAuth |
| Request size | 100MB | More than enough |
| Response size | No hard limit (streaming) | Fine |
| Subrequests (fetch) | 1000 per request | Watch this for web_search (100 keywords × fetches) |

**Critical limit**: 1000 subrequests per Worker invocation. web_search with 100 keywords at 8 concurrent = 100 fetch calls to Serper. deep_research with 10 questions at 3 concurrent = ~30+ fetch calls. Both are well within the 1000 limit. scrape_links with 50 URLs at 10 concurrent + LLM extraction = ~100 fetch calls. All fine.

### File Attachments

The current `deep_research` tool supports file attachments via `services/file-attachment.ts` (reads local filesystem). This **cannot work in Workers** (no filesystem). Options:
1. **Remove file attachments from the Workers entry** — only available in STDIO mode
2. **Accept file content inline** — instead of file paths, accept the content directly in the tool params
3. **Use R2** — Cloudflare R2 for file storage (overkill for this use case)

**Recommendation**: Accept file content inline for Workers, keep file path support for STDIO only. The tool schema can have both `files` (paths, STDIO only) and `file_contents` (inline text, universal).

---

## Migration Order Summary

```
Phase 1: Project setup (wrangler.toml, package.json, tsconfig, env.ts)
Phase 2: Hono entry point (worker.ts — minimal, routes registered)
Phase 3: OAuth for claude.ai (discovery, authorize, token, middleware) ← CRITICAL
Phase 4: MCP protocol handler (JSON-RPC, sessions via KV)
Phase 5: Tool system (TypeScript definitions, registry, execution pipeline)
Phase 6: Client rewrites (accept env, no process.env)
Phase 7: LLM integration (OpenRouter unified client, model config)
Phase 8: STDIO entry (stdio.ts for npm package)
Phase 9: Deploy, test OAuth flow with claude.ai, test all tools
```

**Start with Phase 3 (OAuth) — this is the #1 priority and the hardest to debug. Get the claude.ai connection working first, then wire up tools.**
