/**
 * Hacker News Tool - Search HN via Algolia API
 * NEVER throws - always returns structured response for graceful degradation
 */

import { HackerNewsClient, type HNSearchResult } from '../clients/hackernews.js';
import { classifyError } from '../utils/errors.js';
import {
  formatSuccess,
  formatError,
  countMapValues,
} from './utils.js';

// ============================================================================
// Formatters
// ============================================================================

function formatHNResult(result: HNSearchResult): string {
  const hnUrl = `https://news.ycombinator.com/item?id=${result.objectID}`;
  const date = result.createdAt ? new Date(result.createdAt).toLocaleDateString() : 'unknown date';

  if (result.isStory) {
    let md = `- **${result.title}**\n`;
    md += `  ⬆️ ${result.points} points | 💬 ${result.numComments} comments | by ${result.author} | ${date}\n`;
    md += `  🔗 Discussion: ${hnUrl}\n`;
    if (result.url) {
      md += `  🌐 Article: ${result.url}\n`;
    }
    if (result.storyText) {
      const preview = result.storyText.length > 200 ? result.storyText.slice(0, 200) + '...' : result.storyText;
      md += `  > ${preview}\n`;
    }
    return md;
  } else {
    // Comment
    const preview = result.commentText
      ? (result.commentText.length > 200 ? result.commentText.slice(0, 200) + '...' : result.commentText)
      : '';
    let md = `- **Comment by ${result.author}** (${result.points} points, ${date})\n`;
    md += `  🔗 ${hnUrl}\n`;
    if (preview) {
      md += `  > ${preview}\n`;
    }
    return md;
  }
}

function formatQueryResults(query: string, results: HNSearchResult[]): string {
  if (results.length === 0) {
    return `### "${query}"\n\n_No results found._\n`;
  }

  let md = `### "${query}" (${results.length} results)\n\n`;
  for (const result of results) {
    md += formatHNResult(result);
    md += '\n';
  }
  return md;
}

// ============================================================================
// Error Formatters
// ============================================================================

function formatNoResults(queryCount: number): string {
  return formatError({
    code: 'NO_RESULTS',
    message: `No results found for any of the ${queryCount} queries`,
    toolName: 'search_hackernews',
    howToFix: [
      'Try broader or simpler search terms',
      'Check spelling of technical terms',
      'Relax date_range filter (try "year" or "all")',
      'Lower min_points filter',
    ],
    alternatives: [
      'web_search(keywords=["topic best practices", "topic guide"]) — search the broader web',
      'search_reddit(queries=["topic discussion", "topic recommendations"]) — try Reddit for community discussions',
      'deep_research(questions=[{question: "What are the key findings about [topic]?"}]) — AI-synthesized research',
    ],
  });
}

function formatSearchError(error: unknown): string {
  const structuredError = classifyError(error);
  return formatError({
    code: structuredError.code,
    message: structuredError.message,
    retryable: structuredError.retryable,
    toolName: 'search_hackernews',
    howToFix: ['The Algolia HN API is free and needs no API key — this may be a temporary network issue'],
    alternatives: [
      'web_search(keywords=["topic site:news.ycombinator.com"]) — search HN via Google as fallback',
      'search_reddit(queries=["topic discussion", "topic developer opinion"]) — try Reddit for similar developer discussions',
      'deep_research(questions=[{question: "What does the developer community think about [topic]?"}]) — AI research synthesis',
    ],
  });
}

// ============================================================================
// Handler
// ============================================================================

export async function handleSearchHackerNews(
  queries: string[],
  options?: {
    type?: 'story' | 'comment' | 'all';
    sort_by?: 'relevance' | 'date';
    date_range?: 'day' | 'week' | 'month' | 'year' | 'all';
    min_points?: number;
  },
): Promise<string> {
  try {
    const limited = queries.slice(0, 30);
    const client = new HackerNewsClient();

    const results = await client.searchMultiple(limited, {
      type: options?.type,
      sortBy: options?.sort_by,
      dateRange: options?.date_range,
      minPoints: options?.min_points,
    });

    const totalResults = countMapValues(results);
    if (totalResults === 0) {
      return formatNoResults(limited.length);
    }

    // Build data section with per-query results
    const queryBlocks: string[] = [];
    for (const [query, hits] of results) {
      queryBlocks.push(formatQueryResults(query, hits));
    }

    const seenUrls = new Set<string>();
    const storyUrls: string[] = [];
    for (const hits of results.values()) {
      for (const hit of hits) {
        if (hit.url && !seenUrls.has(hit.url)) {
          seenUrls.add(hit.url);
          storyUrls.push(hit.url);
        }
      }
    }

    const summary = `Found **${totalResults} results** across **${limited.length} queries** from Hacker News.\n`
      + `Filters: type=${options?.type || 'story'}, sort=${options?.sort_by || 'relevance'}, range=${options?.date_range || 'year'}`
      + (options?.min_points ? `, min_points=${options.min_points}` : '');

    const nextSteps: string[] = [
      storyUrls.length > 0
        ? `scrape_links(urls=[${storyUrls.slice(0, 3).map(u => `"${u}"`).join(', ')}...], use_llm=true) — scrape linked articles for full content`
        : null,
      'search_reddit(queries=["topic discussion", "topic recommendations"]) — cross-platform comparison with Reddit',
      'web_search(keywords=["topic latest", "topic official docs"]) — verify claims from HN discussions',
      'deep_research(questions=[{question: "Based on HN discussions about [topic], synthesize key insights"}]) — synthesize findings',
    ].filter(Boolean) as string[];

    return formatSuccess({
      title: `Hacker News Search (${totalResults} results from ${limited.length} queries)`,
      summary,
      data: queryBlocks.join('\n---\n\n'),
      nextSteps,
    });
  } catch (error) {
    return formatSearchError(error);
  }
}
