#!/usr/bin/env npx tsx
/**
 * Benchmark: Workers AI models for LLM content extraction
 * Tests 4 models on the same extraction task and compares quality, speed, and cost.
 *
 * Usage: CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx npx tsx tests/benchmark-extraction.ts
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '0a1119da859d704a3342942f3de6cac2';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!API_TOKEN) {
  // Try to read from wrangler config
  const fs = await import('fs');
  const path = await import('path');
  const configPath = path.join(process.env.HOME || '', 'Library/Preferences/.wrangler/config/default.toml');
  try {
    const config = fs.readFileSync(configPath, 'utf-8');
    const match = config.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) {
      (process.env as any).CLOUDFLARE_API_TOKEN = match[1];
    }
  } catch {}
}

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error('No API token found. Set CLOUDFLARE_API_TOKEN or login with wrangler.');
  process.exit(1);
}

// ── Models to test ──

const MODELS = [
  {
    id: '@cf/moonshotai/kimi-k2.5',
    name: 'Kimi K2.5',
    context: '256K',
    inputPrice: 0.60,   // $ per 1M tokens
    outputPrice: 3.00,
    cachedInput: 0.10,
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    name: 'GPT-OSS 120B',
    context: '128K',
    inputPrice: 0.35,
    outputPrice: 0.75,
  },
  {
    id: '@cf/zai-org/glm-4.7-flash',
    name: 'GLM 4.7 Flash',
    context: '131K',
    inputPrice: 0.06,
    outputPrice: 0.40,
  },
  {
    id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    name: 'Mistral Small 3.1',
    context: '128K',
    inputPrice: 0.35,
    outputPrice: 0.56,
  },
];

// ── Test content (real scraped HTML to extract from) ──

const TEST_CONTENT = `
<html>
<head><title>Top 10 Best Practices for Building MCP Servers in 2026</title></head>
<body>
<nav>Home | Blog | About | Contact</nav>
<div class="ad">Subscribe to our newsletter!</div>
<article>
<h1>Top 10 Best Practices for Building MCP Servers in 2026</h1>
<p>Published: March 15, 2026 | Author: Sarah Chen</p>
<p>The Model Context Protocol (MCP) has become the de facto standard for connecting AI agents to external tools and data sources. After building 50+ MCP servers in production, here are the lessons we've learned.</p>

<h2>1. Use Streamable HTTP Transport</h2>
<p>SSE (Server-Sent Events) is being deprecated in favor of Streamable HTTP. The new transport supports bidirectional communication, better error handling, and works with standard HTTP infrastructure like load balancers and CDNs. Migration is straightforward — most MCP SDKs support both.</p>

<h2>2. Implement OAuth 2.0 with PKCE</h2>
<p>For remote MCP servers, OAuth 2.0 with PKCE (Proof Key for Code Exchange) is now mandatory per the MCP spec (2025-11-25). Use dynamic client registration (RFC 7591) to allow any MCP client to connect. Key endpoints needed: /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server, /oauth/authorize, /oauth/token.</p>

<h2>3. Keep Tools Focused and Composable</h2>
<p>Each tool should do one thing well. Instead of a monolithic "search_everything" tool, split into web_search, search_reddit, search_news, etc. This lets the AI agent compose tools intelligently based on the task.</p>

<h2>4. Never Throw — Always Return Structured Errors</h2>
<p>MCP tools should never crash the server. Use a pattern where errors are caught and returned as { content: [{ type: "text", text: "error message" }], isError: true }. Include recovery suggestions and alternative tools the agent can try.</p>

<h2>5. Use Capability-Based Degradation</h2>
<p>If an API key is missing, don't fail the entire server — just disable that specific tool. Return helpful setup instructions when a disabled tool is called. This makes the server work with any subset of configured API keys.</p>

<h2>6. Implement Bounded Concurrency</h2>
<p>When processing multiple items (URLs to scrape, queries to search), use bounded parallelism (e.g., pMap with concurrency: 8). Unbounded Promise.all() will trigger rate limits and overwhelm APIs. Different operations need different limits: web search (8), scraping (10), LLM calls (3).</p>

<h2>7. Add Retry with Exponential Backoff</h2>
<p>External APIs fail. Implement retry logic with exponential backoff and jitter for 429 (rate limit), 500, 502, 503, 504 status codes. Cap retries at 3 attempts with max 30-second delay. Non-retryable errors (400, 401, 403) should fail fast.</p>

<h2>8. Format Responses with 70/20/10 Pattern</h2>
<p>Structure all tool responses as: 70% summary (key insights, status), 20% structured data (results, tables), 10% actionable next steps (what tool to call next). This helps the AI agent understand results and continue the research loop.</p>

<h2>9. Deploy on Cloudflare Workers</h2>
<p>Workers provide global edge deployment, KV for session/token storage, and native observability. The V8 isolate model handles thousands of concurrent connections efficiently. Use Hono as the web framework — it's built for Workers and has excellent TypeScript support.</p>

<h2>10. Test the Full OAuth Flow</h2>
<p>Before deploying, verify: discovery endpoints return correct metadata, client registration works, PKCE S256 verification passes, tokens have appropriate TTLs (30 days for access tokens, 10 minutes for auth codes), and expired tokens return 401.</p>

<h3>Cost Comparison</h3>
<table>
<tr><th>Service</th><th>Free Tier</th><th>Paid Pricing</th></tr>
<tr><td>Serper (Google Search)</td><td>2,500 queries/mo</td><td>$50/mo for 50K queries</td></tr>
<tr><td>Scrape.do</td><td>1,000 credits/mo</td><td>$29/mo for 50K credits</td></tr>
<tr><td>OpenRouter</td><td>None</td><td>Pay per token (varies by model)</td></tr>
<tr><td>Reddit API</td><td>Unlimited (OAuth)</td><td>Free for client_credentials</td></tr>
</table>
</article>
<footer>© 2026 MCP Best Practices Blog. Privacy Policy | Terms of Service</footer>
<script>analytics.track('page_view')</script>
</body>
</html>
`;

const EXTRACTION_PROMPT = `Extract the key best practices from this article about building MCP servers. Return a structured summary with:
1. Each practice as a numbered item with a one-line summary
2. A cost comparison table if present
3. The most important technical recommendations

Be concise. No preamble. Start with content immediately.

Content:
${TEST_CONTENT}`;

// ── Run benchmark ──

interface BenchmarkResult {
  model: string;
  modelId: string;
  context: string;
  inputPrice: number;
  outputPrice: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  outputLength: number;
  output: string;
  error?: string;
}

async function runModel(model: typeof MODELS[0]): Promise<BenchmarkResult> {
  const start = Date.now();
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${model.id}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: EXTRACTION_PROMPT },
        ],
        max_tokens: 2048,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(60000),
    });

    const latencyMs = Date.now() - start;
    const data = await response.json() as any;

    if (!response.ok || !data.success) {
      return {
        model: model.name,
        modelId: model.id,
        context: model.context,
        inputPrice: model.inputPrice,
        outputPrice: model.outputPrice,
        latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        outputLength: 0,
        output: '',
        error: JSON.stringify(data.errors || data.messages || data),
      };
    }

    const result = data.result;
    // Workers AI returns different formats depending on the model
    const output = result?.response
      || result?.choices?.[0]?.message?.content
      || result?.content
      || (typeof result === 'string' ? result : '');
    // Estimate tokens (~4 chars per token)
    const inputTokens = Math.ceil(EXTRACTION_PROMPT.length / 4);
    const outputTokens = Math.ceil(output.length / 4);
    const estimatedCost =
      (inputTokens / 1_000_000) * model.inputPrice +
      (outputTokens / 1_000_000) * model.outputPrice;

    return {
      model: model.name,
      modelId: model.id,
      context: model.context,
      inputPrice: model.inputPrice,
      outputPrice: model.outputPrice,
      latencyMs,
      inputTokens,
      outputTokens,
      estimatedCost,
      outputLength: output.length,
      output,
    };
  } catch (err: any) {
    return {
      model: model.name,
      modelId: model.id,
      context: model.context,
      inputPrice: model.inputPrice,
      outputPrice: model.outputPrice,
      latencyMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      outputLength: 0,
      output: '',
      error: err.message,
    };
  }
}

// ── Main ──

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Workers AI Extraction Benchmark — 4 Models');
console.log('  Task: Extract structured content from HTML article (~4K chars)');
console.log('═══════════════════════════════════════════════════════════════\n');

const results: BenchmarkResult[] = [];

for (const model of MODELS) {
  process.stdout.write(`Testing ${model.name}...`);
  const result = await runModel(model);
  results.push(result);

  if (result.error) {
    console.log(` ERROR (${result.latencyMs}ms): ${result.error.substring(0, 100)}`);
  } else {
    console.log(` OK (${result.latencyMs}ms, ${result.outputLength} chars)`);
  }
}

// ── Results Table ──

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  RESULTS COMPARISON');
console.log('═══════════════════════════════════════════════════════════════\n');

const header = [
  'Model'.padEnd(20),
  'Context'.padEnd(8),
  'In $/M'.padEnd(8),
  'Out $/M'.padEnd(8),
  'Latency'.padEnd(10),
  'Out Chars'.padEnd(10),
  'Est Cost'.padEnd(12),
  'Status'.padEnd(8),
].join(' ');
console.log(header);
console.log('─'.repeat(96));

for (const r of results) {
  const row = [
    r.model.padEnd(20),
    r.context.padEnd(8),
    `$${r.inputPrice.toFixed(2)}`.padEnd(8),
    `$${r.outputPrice.toFixed(2)}`.padEnd(8),
    `${r.latencyMs}ms`.padEnd(10),
    `${r.outputLength}`.padEnd(10),
    `$${r.estimatedCost.toFixed(6)}`.padEnd(12),
    (r.error ? 'FAIL' : 'OK').padEnd(8),
  ].join(' ');
  console.log(row);
}

// ── vs OpenRouter comparison ──

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  COST COMPARISON: Workers AI vs OpenRouter (per 1M tokens)');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('Workers AI (on your Cloudflare account):');
for (const m of MODELS) {
  console.log(`  ${m.name.padEnd(20)} In: $${m.inputPrice.toFixed(2)}  Out: $${m.outputPrice.toFixed(2)}`);
}
console.log('\nOpenRouter (current extraction model):');
console.log(`  Gemini 2.5 Flash     In: $0.30  Out: $2.50`);
console.log(`  GPT-OSS 120B:nitro   In: $0.65  Out: $0.65`);
console.log('\nNote: Workers AI also includes 10,000 free Neurons/day (~free tier)');

// ── Output Quality ──

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  OUTPUT QUALITY (first 500 chars of each)');
console.log('═══════════════════════════════════════════════════════════════');

for (const r of results) {
  console.log(`\n── ${r.model} ──`);
  if (r.error) {
    console.log(`ERROR: ${r.error.substring(0, 200)}`);
  } else {
    console.log(r.output.substring(0, 500));
    if (r.output.length > 500) console.log('...[truncated]');
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  DONE');
console.log('═══════════════════════════════════════════════════════════════');
