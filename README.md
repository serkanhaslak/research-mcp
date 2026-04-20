# Research MCP

Private MCP research service built for Cloudflare Workers. It exposes a Streamable HTTP MCP endpoint behind capability-URL auth, supports OAuth client registration, and serves a focused set of research tools over a single deployed Worker.

## What It Ships

- `web_search` via Serper
- `search_reddit` via Serper `site:reddit.com`
- `get_reddit_post` via Reddit OAuth API
- `scrape_links` via Scrape.do with fallback modes
- `deep_research` via OpenRouter
- `search_news` via Serper News
- `search_hackernews` via Algolia HN API
- `search_x` via OpenRouter/Grok

Tool availability is capability-based. Missing API keys disable only the dependent tools.

## Architecture

- `src/worker.ts`: Hono app and Worker entrypoint
- `src/routes/`: discovery, OAuth, MCP, health
- `src/mcp/`: session and JSON-RPC handling
- `src/tools/`: tool registry and handlers
- `src/clients/`: external API integrations
- `src/lib/`: retries, formatting, extraction, ranking, concurrency
- `migrations/`: D1 schema and capability seeds

This repo is Cloudflare-service-first. It does not maintain the previous Railway/Node/stdio product shape.

## Local Development

```bash
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm typecheck
pnpm test
pnpm check
npx wrangler deploy --dry-run --env=""
```

## Environment and Bindings

Primary bindings and defaults live in `wrangler.toml`.

Required secrets by capability:

| Variable | Enables |
| --- | --- |
| `SERPER_API_KEY` | `web_search`, `search_reddit`, `search_news` |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `get_reddit_post` |
| `SCRAPEDO_API_KEY` | `scrape_links` |
| `OPENROUTER_API_KEY` | `deep_research`, `search_x`, OpenRouter extraction fallback |

Optional runtime config:

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_BASE_URL` | Override OpenRouter endpoint |
| `RESEARCH_MODEL` | Primary deep research model |
| `RESEARCH_FALLBACK_MODEL` | Fallback research model |
| `LLM_EXTRACTION_MODEL` | Extraction model |
| `LLM_EXTRACTION_FALLBACK_MODEL` | Workers AI extraction fallback |
| `DEFAULT_REASONING_EFFORT` | `low`, `medium`, or `high` |
| `DEFAULT_MAX_URLS` | Max search results for deep research |
| `API_TIMEOUT_MS` | OpenRouter client timeout |

## HTTP Surface

- `GET /health`
- `GET /.well-known/oauth-protected-resource/s/:secret/mcp`
- `GET /.well-known/oauth-authorization-server/s/:secret`
- `GET /s/:secret/.well-known/oauth-authorization-server`
- `POST /s/:secret/oauth/register`
- `GET|POST /s/:secret/oauth/authorize`
- `POST /s/:secret/oauth/token`
- `POST /s/:secret/oauth/revoke`
- `POST|GET|DELETE /s/:secret/mcp`

Bare `/mcp` intentionally returns a capability-URL reminder.

## Deployment

```bash
pnpm deploy
```

Before a real deploy, verify:

```bash
pnpm check
npx wrangler deploy --dry-run --env=""
```
