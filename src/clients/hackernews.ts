/**
 * Hacker News Client
 * Search HN via the free Algolia HN Search API (no API key required)
 * Implements robust error handling that NEVER crashes
 */

import {
  classifyError,
  fetchWithTimeout,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { calculateBackoff } from '../utils/retry.js';
import { pMap } from '../utils/concurrency.js';
import { mcpLog } from '../utils/logger.js';

// ── Constants ──

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search' as const;
const HN_SEARCH_BY_DATE_URL = 'https://hn.algolia.com/api/v1/search_by_date' as const;
const DEFAULT_HITS_PER_PAGE = 20 as const;
const MAX_HITS_PER_PAGE = 50 as const;
const MAX_SEARCH_CONCURRENCY = 8 as const;
const MAX_RETRIES = 3 as const;

// ── Retry Configuration ──

const HN_RETRY_CONFIG = {
  maxRetries: MAX_RETRIES,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  timeoutMs: 30000,
} as const;

const RETRYABLE_HN_CODES = new Set([429, 500, 502, 503, 504]);

// ── Data Interfaces ──

export interface HNSearchResult {
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly points: number;
  readonly numComments: number;
  readonly createdAt: string;
  readonly objectID: string;
  readonly storyText?: string;
  readonly commentText?: string;
  readonly isStory: boolean;
}

interface HNSearchOptions {
  type?: 'story' | 'comment' | 'all';
  sortBy?: 'relevance' | 'date';
  dateRange?: 'day' | 'week' | 'month' | 'year' | 'all';
  minPoints?: number;
}

interface HNApiHit {
  title?: string;
  url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
  objectID?: string;
  story_text?: string;
  comment_text?: string;
  _tags?: string[];
}

interface HNApiResponse {
  hits?: HNApiHit[];
  nbHits?: number;
  page?: number;
  nbPages?: number;
  hitsPerPage?: number;
}

// ── Helpers ──

/**
 * Convert dateRange to Unix timestamp for numericFilters
 */
function getDateTimestamp(dateRange: string): number | null {
  const now = Math.floor(Date.now() / 1000);
  switch (dateRange) {
    case 'day':
      return now - 86400; // 24 hours
    case 'week':
      return now - 604800; // 7 days
    case 'month':
      return now - 2592000; // 30 days
    case 'year':
      return now - 31536000; // 365 days
    case 'all':
      return null;
    default:
      return null;
  }
}

/**
 * Parse a single HN API hit into our result format
 */
function parseHit(hit: HNApiHit): HNSearchResult {
  const tags = hit._tags || [];
  const isStory = tags.includes('story');

  return {
    title: hit.title || (hit.comment_text ? hit.comment_text.slice(0, 100) + '...' : 'No title'),
    url: hit.url || '',
    author: hit.author || 'unknown',
    points: hit.points || 0,
    numComments: hit.num_comments || 0,
    createdAt: hit.created_at || '',
    objectID: hit.objectID || '',
    storyText: hit.story_text || undefined,
    commentText: hit.comment_text || undefined,
    isStory,
  };
}

/**
 * Build the search URL with query parameters
 */
function buildSearchUrl(query: string, options: HNSearchOptions = {}): string {
  const { type = 'story', sortBy = 'relevance', dateRange = 'year', minPoints = 0 } = options;

  const baseUrl = sortBy === 'date' ? HN_SEARCH_BY_DATE_URL : HN_SEARCH_URL;
  const params = new URLSearchParams();

  params.set('query', query);
  params.set('hitsPerPage', String(DEFAULT_HITS_PER_PAGE));

  // Type filter
  if (type === 'story') {
    params.set('tags', 'story');
  } else if (type === 'comment') {
    params.set('tags', 'comment');
  }
  // 'all' = no tags filter

  // Build numeric filters
  const numericFilters: string[] = [];

  // Date range filter
  const timestamp = getDateTimestamp(dateRange);
  if (timestamp !== null) {
    numericFilters.push(`created_at_i>${timestamp}`);
  }

  // Minimum points filter
  if (minPoints > 0) {
    numericFilters.push(`points>${minPoints}`);
  }

  if (numericFilters.length > 0) {
    params.set('numericFilters', numericFilters.join(','));
  }

  return `${baseUrl}?${params.toString()}`;
}

// ── HackerNewsClient ──

export class HackerNewsClient {
  // No API key needed!

  /**
   * Check if error is retryable
   */
  private isRetryable(status?: number, error?: unknown): boolean {
    if (status && RETRYABLE_HN_CODES.has(status)) return true;

    if (error == null) return false;
    const message = (typeof error === 'object' && 'message' in error && typeof (error as { message?: string }).message === 'string')
      ? (error as { message: string }).message.toLowerCase()
      : '';
    return message.includes('timeout') || message.includes('rate limit') || message.includes('connection');
  }

  /**
   * Search Hacker News for a single query
   * NEVER throws - returns empty array on failure
   */
  async search(query: string, options: HNSearchOptions = {}): Promise<HNSearchResult[]> {
    if (!query?.trim()) {
      return [];
    }

    const url = buildSearchUrl(query, options);

    for (let attempt = 0; attempt <= HN_RETRY_CONFIG.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          mcpLog('warning', `HN search retry attempt ${attempt}/${HN_RETRY_CONFIG.maxRetries}`, 'hackernews');
        }

        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          timeoutMs: HN_RETRY_CONFIG.timeoutMs,
        });

        if (!response.ok) {
          if (this.isRetryable(response.status) && attempt < HN_RETRY_CONFIG.maxRetries) {
            const delayMs = calculateBackoff(attempt, HN_RETRY_CONFIG.baseDelayMs, HN_RETRY_CONFIG.maxDelayMs);
            mcpLog('warning', `HN search ${response.status}, retrying in ${delayMs}ms...`, 'hackernews');
            await sleep(delayMs);
            continue;
          }
          mcpLog('error', `HN search failed with status ${response.status}`, 'hackernews');
          return [];
        }

        let data: HNApiResponse;
        try {
          data = await response.json() as HNApiResponse;
        } catch {
          mcpLog('error', 'Failed to parse HN search response', 'hackernews');
          return [];
        }

        const hits = data.hits || [];
        return hits.map(parseHit);
      } catch (error) {
        const err = classifyError(error);
        if (this.isRetryable(undefined, error) && attempt < HN_RETRY_CONFIG.maxRetries) {
          const delayMs = calculateBackoff(attempt, HN_RETRY_CONFIG.baseDelayMs, HN_RETRY_CONFIG.maxDelayMs);
          mcpLog('warning', `HN search ${err.code}, retrying in ${delayMs}ms...`, 'hackernews');
          await sleep(delayMs);
          continue;
        }
        mcpLog('error', `HN search failed: ${err.message}`, 'hackernews');
        return [];
      }
    }

    return [];
  }

  /**
   * Search Hacker News with multiple queries (bounded concurrency)
   * NEVER throws - search never throws, pMap preserves order
   */
  async searchMultiple(queries: string[], options: HNSearchOptions = {}): Promise<Map<string, HNSearchResult[]>> {
    if (queries.length === 0) {
      return new Map();
    }

    const results = await pMap(
      queries,
      q => this.search(q, options),
      MAX_SEARCH_CONCURRENCY,
    );

    return new Map(queries.map((q, i) => [q, results[i] || []]));
  }
}
