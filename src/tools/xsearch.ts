/**
 * X/Twitter Search Tool - Search X posts via Grok + OpenRouter
 * NEVER throws - always returns structured response for graceful degradation
 */

import { XSearchClient, type XSearchQuery, type XSearchResult } from '../clients/xsearch.js';
import { classifyError } from '../utils/errors.js';
import { formatSuccess, formatError } from './utils.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_CONCURRENCY = 5 as const;

// ============================================================================
// Formatters
// ============================================================================

function formatSingleResult(result: XSearchResult): string {
  const parts: string[] = [];

  if (result.error) {
    parts.push(`### "${result.query}" — ❌ Error\n`);
    parts.push(`**${result.error.code}:** ${result.error.message}\n`);
    return parts.join('\n');
  }

  parts.push(`### "${result.query}"\n`);

  if (result.content) {
    parts.push(result.content);
  } else {
    parts.push('_No results found for this query._');
  }

  const xLinks = result.annotations.filter(a => a.url.includes('x.com') || a.url.includes('twitter.com'));
  if (xLinks.length > 0) {
    parts.push('\n**X Post Links:**');
    for (const link of xLinks) {
      parts.push(`- [${link.title || link.url}](${link.url})`);
    }
  }

  if (result.usage) {
    parts.push(`\n_Tokens: ${result.usage.totalTokens.toLocaleString()}_`);
  }

  return parts.join('\n');
}

function formatResults(results: XSearchResult[]): string {
  return results.map(formatSingleResult).join('\n\n---\n\n');
}

// ============================================================================
// Error Formatters
// ============================================================================

function formatNoResults(queryCount: number): string {
  return formatError({
    code: 'NO_RESULTS',
    message: `No X/Twitter results found for any of the ${queryCount} queries`,
    toolName: 'search_x',
    howToFix: [
      'Try broader or simpler search terms',
      'Remove date filters to search all time',
      'Remove handle filters to search all users',
      'Check that @handles are spelled correctly (without the @ prefix)',
    ],
    alternatives: [
      'web_search(keywords=["topic site:x.com", "topic site:twitter.com"]) — search via Google for indexed X posts',
      'search_reddit(queries=["topic twitter", "topic tweet"]) — check Reddit for discussions about X posts',
      'deep_research(questions=[{question: "What are people saying about [topic] on X/Twitter?"}]) — AI research synthesis',
    ],
  });
}

function formatSearchXError(error: unknown): string {
  const structured = classifyError(error);
  return formatError({
    code: structured.code,
    message: structured.message,
    retryable: structured.retryable,
    toolName: 'search_x',
    howToFix: [
      'Verify OPENROUTER_API_KEY is set and has credits',
      'The Grok model on OpenRouter may be temporarily unavailable — try again',
    ],
    alternatives: [
      'web_search(keywords=["topic site:x.com"]) — search Google for X posts (uses SERPER_API_KEY instead)',
      'search_reddit(queries=["topic"]) — search Reddit as alternative social platform',
      'search_hackernews(queries=["topic"]) — search Hacker News for tech discussions',
    ],
  });
}

// ============================================================================
// Handler
// ============================================================================

export type SearchXParams = Omit<XSearchQuery, 'query'> & { readonly queries: string[] };

export async function handleSearchX(params: SearchXParams): Promise<string> {
  try {
    const { queries, ...filters } = params;

    const searchQueries: XSearchQuery[] = queries.map(q => ({ query: q, ...filters }));

    const client = new XSearchClient();
    const results = await client.searchMultiple(searchQueries, MAX_CONCURRENCY);

    let successCount = 0;
    let failCount = 0;
    let totalCitations = 0;
    let totalTokens = 0;
    for (const r of results) {
      if (r.error) failCount++;
      else if (r.content) successCount++;
      totalCitations += r.annotations.length;
      totalTokens += r.usage?.totalTokens || 0;
    }

    if (successCount === 0) {
      return formatNoResults(queries.length);
    }

    const formattedData = formatResults(results);

    const filterDesc: string[] = [];
    if (filters.from_handles?.length) filterDesc.push(`from: @${filters.from_handles.join(', @')}`);
    if (filters.exclude_handles?.length) filterDesc.push(`excluding: @${filters.exclude_handles.join(', @')}`);
    if (filters.from_date) filterDesc.push(`after: ${filters.from_date}`);
    if (filters.to_date) filterDesc.push(`before: ${filters.to_date}`);
    const filterLabel = filterDesc.length > 0 ? ` | Filters: ${filterDesc.join(', ')}` : '';

    return formatSuccess({
      title: `X/Twitter Search: ${successCount}/${queries.length} queries returned results${filterLabel}`,
      summary: `Searched ${queries.length} queries on X/Twitter via Grok. ${successCount} returned results, ${failCount} failed. ${totalCitations} citations found. ${totalTokens.toLocaleString()} tokens used.`,
      data: formattedData,
      nextSteps: [
        `scrape_links(urls=[...X post URLs above...], use_llm=true, what_to_extract="post content|author|engagement|replies|context") — get full post content and metadata`,
        `search_x(queries=[...follow-up angles...]) — search for related X discussions or different perspectives`,
        `search_reddit(queries=["topic"]) — cross-reference with Reddit community discussions`,
        `deep_research(questions=[{question: "Based on X/Twitter discussions about [topic], what are the key insights?"}]) — synthesize findings`,
        `web_search(keywords=["topic"]) — get broader web context beyond social media`,
      ],
    });
  } catch (error) {
    return formatSearchXError(error);
  }
}
