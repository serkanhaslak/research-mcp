import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctorSpy = vi.fn();
const researchSpy = vi.fn();
const xSearchMultipleSpy = vi.fn();
const extractSpy = vi.fn();

vi.mock('../src/clients/openrouter.js', () => ({
  OpenRouterClient: class MockOpenRouterClient {
    constructor(apiKey: string, options?: Record<string, unknown>) {
      ctorSpy(apiKey, options);
    }

    research = researchSpy;
    xSearchMultiple = xSearchMultipleSpy;
    extract = extractSpy;
  },
}));

const baseEnv = {
  OAUTH_TOKENS: {} as KVNamespace,
  MCP_SESSIONS: {} as KVNamespace,
  AUTH_DB: {} as D1Database,
  SERVER_NAME: 'research-mcp',
  SERVER_VERSION: '5.0.0',
  MCP_PROTOCOL_VERSION: '2025-11-25',
  SESSION_TTL_SECONDS: '2592000',
  MAX_SESSIONS: '100',
  API_TIMEOUT_MS: '12345',
  OPENROUTER_API_KEY: 'test-key',
  OPENROUTER_BASE_URL: 'https://openrouter.example/api/v1',
} as const;

describe('OpenRouter base URL propagation', () => {
  beforeEach(() => {
    ctorSpy.mockReset();
    researchSpy.mockReset();
    xSearchMultipleSpy.mockReset();
    extractSpy.mockReset();
  });

  it('passes OPENROUTER_BASE_URL to deep_research', async () => {
    const { deepResearchTool } = await import('../src/tools/deep-research.js');

    researchSpy.mockResolvedValue({
      content: 'ok',
      usage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 },
      annotations: [],
    });

    await deepResearchTool.handler(
      {
        questions: [{ question: 'Explain how OAuth discovery works for MCP servers.' }],
      },
      baseEnv,
    );

    expect(ctorSpy).toHaveBeenCalledWith(
      'test-key',
      expect.objectContaining({
        baseUrl: 'https://openrouter.example/api/v1',
        timeout: 12345,
      }),
    );
  });

  it('passes OPENROUTER_BASE_URL to search_x', async () => {
    const { xSearchTool } = await import('../src/tools/x-search.js');

    xSearchMultipleSpy.mockResolvedValue([
      {
        query: 'mcp oauth',
        content: 'result',
        annotations: [],
        usage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 },
      },
    ]);

    await xSearchTool.handler(
      {
        queries: ['mcp oauth'],
      },
      baseEnv,
    );

    expect(ctorSpy).toHaveBeenCalledWith(
      'test-key',
      expect.objectContaining({
        baseUrl: 'https://openrouter.example/api/v1',
        timeout: 12345,
      }),
    );
  });

  it('passes OPENROUTER_BASE_URL to extractContent fallback', async () => {
    const { extractContent } = await import('../src/lib/extraction.js');

    extractSpy.mockResolvedValue({
      content: 'cleaned',
      processed: true,
    });

    await extractContent(baseEnv, 'some content', 'extract facts');

    expect(ctorSpy).toHaveBeenCalledWith(
      'test-key',
      expect.objectContaining({
        baseUrl: 'https://openrouter.example/api/v1',
        timeout: 12345,
      }),
    );
  });
});
