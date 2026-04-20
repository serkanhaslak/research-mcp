import { describe, expect, it } from 'vitest';

import app from '../src/worker.js';
import { sha256Hex } from '../src/auth/capability.js';

class MemoryKV {
  private store = new Map<string, string>();

  async get(key: string, type?: 'text' | 'json') {
    const value = this.store.get(key) ?? null;
    if (value == null) return null;
    if (type === 'json') return JSON.parse(value);
    return value;
  }

  async put(key: string, value: string, _options?: unknown) {
    this.store.set(key, value);
  }

  async delete(key: string) {
    this.store.delete(key);
  }
}

class MemoryD1Database {
  constructor(
    private readonly allowedClients: Map<string, { email: string; revoked: number; lastUsedAt?: number }>
  ) {}

  prepare(sql: string) {
    const db = this;
    return {
      bind(...args: unknown[]) {
        return {
          async first<T>() {
            if (sql.includes('SELECT email, revoked FROM allowed_clients')) {
              const hash = String(args[0]);
              const row = db.allowedClients.get(hash);
              return (row ? { email: row.email, revoked: row.revoked } : null) as T | null;
            }
            return null as T | null;
          },
          async run() {
            if (sql.includes('UPDATE allowed_clients SET last_used_at')) {
              const lastUsedAt = Number(args[0]);
              const hash = String(args[1]);
              const row = db.allowedClients.get(hash);
              if (row) {
                db.allowedClients.set(hash, { ...row, lastUsedAt });
              }
            }
            return { success: true };
          },
        };
      },
    };
  }
}

function createExecutionContext() {
  return {
    waitUntil: (promise: Promise<unknown>) => promise.catch(() => undefined),
    passThroughOnException: () => undefined,
  };
}

async function createTestEnv() {
  const plaintextSecret = 'cap-secret-123';
  const secretHash = await sha256Hex(plaintextSecret);
  const allowedClients = new Map([
    [secretHash, { email: 'test@example.com', revoked: 0 }],
  ]);

  return {
    plaintextSecret,
    env: {
      OAUTH_TOKENS: new MemoryKV(),
      MCP_SESSIONS: new MemoryKV(),
      AUTH_DB: new MemoryD1Database(allowedClients),
      AI: undefined,
      SERVER_NAME: 'research-mcp',
      SERVER_VERSION: '5.0.0',
      MCP_PROTOCOL_VERSION: '2025-11-25',
      SESSION_TTL_SECONDS: '2592000',
      MAX_SESSIONS: '100',
      DEFAULT_REASONING_EFFORT: 'high',
      DEFAULT_MAX_URLS: '100',
      API_TIMEOUT_MS: '300000',
    },
  };
}

async function request(
  env: Awaited<ReturnType<typeof createTestEnv>>['env'],
  path: string,
  init?: RequestInit,
) {
  return app.fetch(
    new Request(`https://research-mcp.example${path}`, init),
    env as never,
    createExecutionContext() as never,
  );
}

function toBase64Url(input: ArrayBuffer) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function createCodeChallenge(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(digest);
}

describe('worker HTTP contract', () => {
  it('returns capability guidance on bare /mcp', async () => {
    const { env } = await createTestEnv();
    const response = await request(env, '/mcp');
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual(
      expect.objectContaining({
        error: 'capability_url_required',
      }),
    );
  });

  it('serves discovery metadata for a valid capability secret', async () => {
    const { env, plaintextSecret } = await createTestEnv();
    const response = await request(env, `/.well-known/oauth-protected-resource/s/${plaintextSecret}/mcp`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      resource: `https://research-mcp.example/s/${plaintextSecret}/mcp`,
      authorization_servers: [`https://research-mcp.example/s/${plaintextSecret}`],
      bearer_methods_supported: ['header'],
    });
  });

  it('completes OAuth registration and MCP session flow', async () => {
    const { env, plaintextSecret } = await createTestEnv();

    const registerResponse = await request(env, `/s/${plaintextSecret}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test Client',
        redirect_uris: ['https://client.example/callback'],
      }),
    });
    const registerBody = await registerResponse.json();
    expect(registerResponse.status).toBe(201);
    expect(registerBody.client_id).toBeTypeOf('string');

    const codeVerifier = 'verifier-123456789';
    const codeChallenge = await createCodeChallenge(codeVerifier);
    const authorizeResponse = await request(
      env,
      `/s/${plaintextSecret}/oauth/authorize?client_id=${registerBody.client_id}&redirect_uri=${encodeURIComponent('https://client.example/callback')}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=abc123`,
    );

    expect(authorizeResponse.status).toBe(302);
    const redirectLocation = authorizeResponse.headers.get('location');
    expect(redirectLocation).toBeTruthy();
    const redirectUrl = new URL(redirectLocation!);
    expect(redirectUrl.searchParams.get('state')).toBe('abc123');
    const authCode = redirectUrl.searchParams.get('code');
    expect(authCode).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode!,
      code_verifier: codeVerifier,
      client_id: registerBody.client_id,
      redirect_uri: 'https://client.example/callback',
    });
    const tokenResponse = await request(env, `/s/${plaintextSecret}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    const tokenPayload = await tokenResponse.json();

    expect(tokenResponse.status).toBe(200);
    expect(tokenPayload.access_token).toBeTypeOf('string');

    const unauthorizedMcpResponse = await request(env, `/s/${plaintextSecret}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(unauthorizedMcpResponse.status).toBe(401);

    const initializeResponse = await request(env, `/s/${plaintextSecret}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const initializePayload = await initializeResponse.json();
    const sessionId = initializeResponse.headers.get('mcp-session-id');

    expect(initializeResponse.status).toBe(200);
    expect(sessionId).toBeTruthy();
    expect(initializePayload.result.protocolVersion).toBe('2025-11-25');

    const toolsListResponse = await request(env, `/s/${plaintextSecret}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'content-type': 'application/json',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const toolsListPayload = await toolsListResponse.json();

    expect(toolsListResponse.status).toBe(200);
    expect(toolsListPayload.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'search_hackernews',
    ]);

    const sessionInfoResponse = await request(env, `/s/${plaintextSecret}/mcp`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'mcp-session-id': sessionId!,
      },
    });
    const sessionInfoPayload = await sessionInfoResponse.json();

    expect(sessionInfoResponse.status).toBe(200);
    expect(sessionInfoPayload).toEqual(
      expect.objectContaining({
        sessionId,
        active: true,
        protocolVersion: '2025-11-25',
      }),
    );

    const deleteResponse = await request(env, `/s/${plaintextSecret}/mcp`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'mcp-session-id': sessionId!,
      },
    });
    expect(deleteResponse.status).toBe(200);

    const deletedSessionResponse = await request(env, `/s/${plaintextSecret}/mcp`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'mcp-session-id': sessionId!,
      },
    });
    expect(deletedSessionResponse.status).toBe(404);
  });
});
