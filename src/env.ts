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

  // OAuth (not used — dynamic client registration handles clients)
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;

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
  search: boolean;
  reddit: boolean;
  scraping: boolean;
  deepResearch: boolean;
  xSearch: boolean;
  llmExtraction: boolean;
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
