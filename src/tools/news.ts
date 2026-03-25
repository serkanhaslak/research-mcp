/**
 * News Search Tool - Search Google News via Serper
 * NEVER throws - always returns structured response for graceful degradation
 */

import { SearchClient, type NewsSearchResult } from '../clients/search.js';
import { classifyError } from '../utils/errors.js';
import {
  formatSuccess,
  formatError,
  countMapValues,
} from './utils.js';

// ============================================================================
// Helpers
// ============================================================================

function formatNewsResult(result: NewsSearchResult, index: number): string {
  const parts: string[] = [];
  parts.push(`**${index}. ${result.title}**`);
  const meta: string[] = [];
  if (result.source) meta.push(result.source);
  if (result.date) meta.push(result.date);
  if (meta.length > 0) {
    parts.push(`   _${meta.join(' • ')}_`);
  }
  if (result.snippet) {
    parts.push(`   ${result.snippet}`);
  }
  parts.push(`   ${result.url}`);
  return parts.join('\n');
}

function formatNewsResults(results: Map<string, NewsSearchResult[]>): string {
  const sections: string[] = [];
  let globalIndex = 1;

  for (const [query, items] of results) {
    if (items.length === 0) continue;
    sections.push(`### "${query}" (${items.length} results)\n`);
    for (const item of items) {
      sections.push(formatNewsResult(item, globalIndex++));
    }
    sections.push('');
  }

  return sections.join('\n');
}

// ============================================================================
// Error Formatters
// ============================================================================

function formatNoSearchResults(queryCount: number): string {
  return formatError({
    code: 'NO_RESULTS',
    message: `No news results found for any of the ${queryCount} queries`,
    toolName: 'search_news',
    howToFix: [
      'Try broader or simpler search terms',
      'Remove date_range filter to search all time',
      'Check spelling of names and technical terms',
    ],
    alternatives: [
      'web_search(keywords=["topic latest news", "topic announcement", "topic update 2025"]) — try general web search instead',
      'search_reddit(queries=["topic news", "topic announcement", "topic update"]) — check Reddit for community discussion',
      'deep_research(questions=[{question: "What are the latest developments on [topic]?"}]) — AI-powered research synthesis',
    ],
  });
}

function formatSearchNewsError(error: unknown): string {
  const structuredError = classifyError(error);
  return formatError({
    code: structuredError.code,
    message: structuredError.message,
    retryable: structuredError.retryable,
    toolName: 'search_news',
    howToFix: ['Verify SERPER_API_KEY is set correctly'],
    alternatives: [
      'web_search(keywords=["topic latest news", "topic breaking", "topic announcement"]) — uses the same API key, but try anyway as it may work for general search',
      'deep_research(questions=[{question: "What are the latest news and developments on [topic]?"}]) — uses a different API (OpenRouter), not affected by this error',
      'scrape_links(urls=[...any news URLs you already have...], use_llm=true) — if you have URLs from prior steps, scrape them now',
    ],
  });
}

// ============================================================================
// Search News Handler
// ============================================================================

export async function handleSearchNews(
  queries: string[],
  apiKey: string,
  dateRange?: 'day' | 'week' | 'month' | 'year',
): Promise<string> {
  try {
    const limited = queries.slice(0, 30);
    const client = new SearchClient(apiKey);
    const results = await client.searchNewsMultiple(limited, dateRange);

    const totalResults = countMapValues(results);
    if (totalResults === 0) {
      return formatNoSearchResults(limited.length);
    }

    const dateLabel = dateRange ? ` (${dateRange})` : '';
    const formattedData = formatNewsResults(results);

    return formatSuccess({
      title: `News Search Results: ${totalResults} articles from ${limited.length} queries${dateLabel}`,
      summary: `Found ${totalResults} news articles across ${limited.length} search queries.`,
      data: formattedData,
      nextSteps: [
        `scrape_links(urls=[...article URLs above...], use_llm=true, what_to_extract="key facts|quotes|data|timeline|impact") — get full article content from the most relevant results`,
        `deep_research(questions=[{question: "Based on these news findings about [topic], what are the implications and key takeaways?"}]) — synthesize across multiple articles`,
        `search_news(queries=[...follow-up angles...]) — search for related developments or different perspectives`,
        `web_search(keywords=["topic background", "topic analysis", "topic expert opinion"]) — get broader context beyond news`,
        `search_reddit(queries=["topic discussion", "topic reaction", "topic opinion"]) — see community reactions to the news`,
      ],
    });
  } catch (error) {
    return formatSearchNewsError(error);
  }
}
