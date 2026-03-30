/**
 * Reddit OAuth API Client
 * Fetches posts and comments sorted by score (most upvoted first)
 * Implements robust error handling that NEVER crashes
 *
 * Cloudflare Workers compatible — uses KV for token caching, btoa() for base64
 */

import {
  classifyError,
  fetchWithTimeout,
  sleep,
  calculateBackoff,
  ErrorCode,
  type StructuredError,
} from '../lib/errors.js';
import { pMap, pMapSettled } from '../lib/concurrency.js';

// ── Constants ──

const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token' as const;
const REDDIT_API_BASE = 'https://oauth.reddit.com' as const;

const REDDIT_CONFIG = {
  MAX_COMMENT_BUDGET: 1000,
  MAX_COMMENTS_PER_POST: 200,
  MIN_POSTS: 2,
  MAX_POSTS: 50,
  BATCH_SIZE: 10,
  RETRY_COUNT: 5,
  RETRY_DELAYS: [2000, 4000, 8000, 16000, 32000] as const,
} as const;

const USER_AGENT = 'script:research-mcp/5.0.0 (by /u/research-mcp)' as const;

// ── Data Interfaces ──

interface Post {
  readonly title: string;
  readonly author: string;
  readonly subreddit: string;
  readonly body: string;
  readonly score: number;
  readonly commentCount: number;
  readonly url: string;
  readonly created: Date;
  readonly flair?: string;
  readonly isNsfw: boolean;
  readonly isPinned: boolean;
}

export interface Comment {
  readonly author: string;
  readonly body: string;
  readonly score: number;
  readonly depth: number;
  readonly isOP: boolean;
}

export interface PostResult {
  readonly post: Post;
  readonly comments: Comment[];
  readonly allocatedComments: number;
  readonly actualComments: number;
}

interface BatchPostResult {
  readonly results: Map<string, PostResult | Error>;
  readonly batchesProcessed: number;
  readonly totalPosts: number;
  readonly rateLimitHits: number;
  readonly commentAllocation: CommentAllocation;
}

interface CommentAllocation {
  readonly totalBudget: number;
  readonly perPostBase: number;
  readonly perPostCapped: number;
  redistributed: boolean;
}

/** Reddit API "Listing" wrapper */
interface RedditListing<T> {
  readonly kind: string;
  readonly data: {
    readonly children: ReadonlyArray<{ readonly kind: string; readonly data: T }>;
    readonly after?: string;
    readonly before?: string;
  };
}

/** Reddit post data from API */
interface RedditPostData {
  readonly title: string;
  readonly selftext: string;
  readonly selftext_html?: string;
  readonly author: string;
  readonly subreddit: string;
  readonly score: number;
  readonly upvote_ratio: number;
  readonly num_comments: number;
  readonly created_utc: number;
  readonly url: string;
  readonly permalink: string;
  readonly is_self: boolean;
  readonly over_18: boolean;
  readonly stickied: boolean;
  readonly link_flair_text?: string;
  readonly [key: string]: unknown;
}

/** Reddit comment data from API */
interface RedditCommentData {
  readonly body?: string;
  readonly author?: string;
  readonly score?: number;
  readonly created_utc?: number;
  readonly replies?: RedditListing<RedditCommentData> | string;
  readonly [key: string]: unknown;
}

type RedditPostResponse = [RedditListing<RedditPostData>, RedditListing<RedditCommentData>];

export function calculateCommentAllocation(postCount: number): CommentAllocation {
  const totalBudget = REDDIT_CONFIG.MAX_COMMENT_BUDGET;
  const perPostBase = Math.floor(totalBudget / postCount);
  const perPostCapped = Math.min(perPostBase, REDDIT_CONFIG.MAX_COMMENTS_PER_POST);
  return { totalBudget, perPostBase, perPostCapped, redistributed: false };
}

// ── Decomposed Helpers ──

/**
 * Fetch a Reddit post's JSON from the API
 */
export const COMMENT_SORTS = ['top', 'confidence', 'new', 'controversial', 'old', 'qa'] as const;
export type CommentSort = typeof COMMENT_SORTS[number];

async function fetchRedditJson(
  sub: string,
  id: string,
  maxComments: number,
  token: string,
  sort: CommentSort = 'top',
): Promise<RedditPostResponse> {
  const limit = Math.min(maxComments, 500);
  const apiUrl = `${REDDIT_API_BASE}/r/${sub}/comments/${id}?sort=${sort}&limit=${limit}&depth=10&raw_json=1`;

  const res = await fetchWithTimeout(apiUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': USER_AGENT,
    },
    timeoutMs: 30000,
  });

  if (res.status === 429) {
    const err = new Error('Rate limited by Reddit API');
    (err as Error & { status: number }).status = 429;
    throw err;
  }

  if (res.status === 404) {
    throw new Error(`Post not found: /r/${sub}/comments/${id}`);
  }

  if (!res.ok) {
    const err = new Error(`Reddit API error: ${res.status}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }

  try {
    return await res.json() as RedditPostResponse;
  } catch {
    throw new Error('Failed to parse Reddit API response');
  }
}

/**
 * Extract structured post data from a Reddit listing
 */
function parsePostData(
  postListing: RedditListing<RedditPostData>,
  sub: string,
): Post {
  const p = postListing?.data?.children?.[0]?.data;
  if (!p) {
    throw new Error(`Post data not found in response for /r/${sub}`);
  }

  return {
    title: p.title || 'Untitled',
    author: p.author || '[deleted]',
    subreddit: p.subreddit || sub,
    body: formatBody(p),
    score: p.score || 0,
    commentCount: p.num_comments || 0,
    url: `https://reddit.com${p.permalink || ''}`,
    created: new Date((p.created_utc || 0) * 1000),
    flair: p.link_flair_text || undefined,
    isNsfw: p.over_18 || false,
    isPinned: p.stickied || false,
  };
}

function formatBody(p: RedditPostData): string {
  if (p.selftext?.trim()) return p.selftext;
  if (p.is_self) return '';
  if (p.url) return `**Link:** ${p.url}`;
  return '';
}

/**
 * Extract and sort comments from a Reddit comment listing
 */
function parseCommentTree(
  commentListing: RedditListing<RedditCommentData>,
  maxComments: number,
  opAuthor: string,
): Comment[] {
  const result: Comment[] = [];

  const extract = (items: ReadonlyArray<{ readonly kind: string; readonly data: RedditCommentData }>, depth = 0): void => {
    const sorted = [...items].sort((a, b) => (b.data?.score || 0) - (a.data?.score || 0));

    for (const c of sorted) {
      if (result.length >= maxComments) return;
      if (c.kind !== 't1' || !c.data?.author || c.data.author === '[deleted]') continue;

      result.push({
        author: c.data.author,
        body: c.data.body || '',
        score: c.data.score || 0,
        depth,
        isOP: c.data.author === opAuthor,
      });

      if (typeof c.data.replies === 'object' && c.data.replies?.data?.children && result.length < maxComments) {
        extract(c.data.replies.data.children, depth + 1);
      }
    }
  };

  extract(commentListing?.data?.children || []);
  return result;
}

// ── Batch Helpers ──

/**
 * Process a single batch of Reddit URLs, returning results keyed by URL
 */
async function processBatch(
  client: RedditClient,
  batchUrls: string[],
  maxComments: number,
  sort: CommentSort = 'top',
): Promise<{ results: Map<string, PostResult | Error>; rateLimitHits: number }> {
  const results = new Map<string, PostResult | Error>();
  let rateLimitHits = 0;

  const batchResults = await pMapSettled(
    batchUrls,
    url => client.getPost(url, maxComments, sort),
    5,
  );

  for (let i = 0; i < batchResults.length; i++) {
    const result = batchResults[i];
    if (!result) continue;
    const url = batchUrls[i] ?? '';

    if (result.status === 'fulfilled') {
      results.set(url, result.value);
    } else {
      const errorMsg = result.reason?.message || String(result.reason);
      if (errorMsg.includes('429') || errorMsg.includes('rate')) rateLimitHits++;
      results.set(url, new Error(errorMsg));
    }
  }

  return { results, rateLimitHits };
}

/**
 * Phase 2: Redistribute surplus comments to truncated posts
 */
async function redistributeComments(
  client: RedditClient,
  allResults: Map<string, PostResult | Error>,
  allocation: CommentAllocation,
  initialPerPost: number,
  sort: CommentSort = 'top',
): Promise<number> {
  let surplus = 0;
  const truncatedUrls: string[] = [];
  let rateLimitHits = 0;

  for (const [url, result] of allResults) {
    if (result instanceof Error) continue;
    const used = result.comments.length;
    if (used < initialPerPost) {
      surplus += initialPerPost - used;
    } else if (result.post.commentCount > used) {
      truncatedUrls.push(url);
    }
  }

  if (surplus > 0 && truncatedUrls.length > 0) {
    const extraPerPost = Math.min(
      Math.floor(surplus / truncatedUrls.length),
      REDDIT_CONFIG.MAX_COMMENTS_PER_POST,
    );
    const newLimit = Math.min(initialPerPost + extraPerPost, REDDIT_CONFIG.MAX_COMMENTS_PER_POST);

    allocation.redistributed = true;
    console.warn(`[reddit] Phase 2: Redistributing ${surplus} surplus comments to ${truncatedUrls.length} truncated post(s) (${initialPerPost} -> ${newLimit}/post)`);

    const refetchResults = await pMapSettled(
      truncatedUrls,
      url => client.getPost(url, newLimit, sort),
      5,
    );

    for (let i = 0; i < refetchResults.length; i++) {
      const result = refetchResults[i];
      if (!result) continue;
      const url = truncatedUrls[i] ?? '';
      if (result.status === 'fulfilled') {
        allResults.set(url, result.value);
      } else {
        const errorMsg = result.reason?.message || String(result.reason);
        if (errorMsg.includes('429') || errorMsg.includes('rate')) rateLimitHits++;
      }
    }

    console.warn(`[reddit] Phase 2 complete: re-fetched ${truncatedUrls.length} post(s)`);
  }

  return rateLimitHits;
}

// ── RedditClient Class ──

export class RedditClient {
  /** Instance-level pending auth promise (replaces module-level) */
  private pendingAuthPromise: Promise<string | null> | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private kv?: KVNamespace,
  ) {}

  /**
   * Get an OAuth token, with KV-based caching if available
   */
  private async getToken(): Promise<string | null> {
    // Check KV cache first
    if (this.kv) {
      const cached = await this.kv.get('reddit:oauth_token');
      if (cached) return cached;
    }

    // Deduplicate concurrent auth calls at instance level
    if (this.pendingAuthPromise) {
      return this.pendingAuthPromise;
    }

    this.pendingAuthPromise = this.performAuth();
    try {
      return await this.pendingAuthPromise;
    } finally {
      this.pendingAuthPromise = null;
    }
  }

  private async performAuth(): Promise<string | null> {
    const credentials = btoa(`${this.clientId}:${this.clientSecret}`);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchWithTimeout(REDDIT_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: 'grant_type=client_credentials',
          timeoutMs: 15000,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.error(`[reddit] Auth failed (${res.status}): ${text}`);

          if (res.status === 401 || res.status === 403) {
            return null;
          }

          if (res.status >= 500 && attempt < 2) {
            await sleep(calculateBackoff(attempt));
            continue;
          }

          return null;
        }

        const data = await res.json() as { access_token?: string; expires_in?: number };
        if (!data.access_token) {
          console.error('[reddit] Auth response missing access_token');
          return null;
        }

        // Cache in KV if available
        if (this.kv && data.access_token) {
          await this.kv.put('reddit:oauth_token', data.access_token, {
            expirationTtl: Math.max((data.expires_in || 3600) - 60, 60),
          });
        }

        return data.access_token;

      } catch (error) {
        const err = classifyError(error);
        console.error(`[reddit] Auth error (attempt ${attempt + 1}): ${err.message}`);

        if (attempt < 2 && err.retryable) {
          await sleep(calculateBackoff(attempt));
          continue;
        }

        return null;
      }
    }

    return null;
  }

  private parseUrl(url: string): { sub: string; id: string } | null {
    const m = url.match(/reddit\.com\/r\/([^\/]+)\/comments\/([a-z0-9]+)/i);
    return m ? { sub: m[1]!, id: m[2]! } : null;
  }

  /**
   * Get a single Reddit post with comments
   * Returns PostResult or throws Error (for use with Promise.allSettled)
   */
  async getPost(url: string, maxComments = 100, sort: CommentSort = 'top'): Promise<PostResult> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      throw new Error(`Invalid Reddit URL format: ${url}`);
    }

    const token = await this.getToken();
    if (!token) {
      throw new Error('Reddit authentication failed - check credentials');
    }

    let lastError: StructuredError | null = null;

    for (let attempt = 0; attempt < REDDIT_CONFIG.RETRY_COUNT; attempt++) {
      try {
        const data = await fetchRedditJson(parsed.sub, parsed.id, maxComments, token, sort);
        const [postListing, commentListing] = data;

        const post = parsePostData(postListing, parsed.sub);
        const comments = parseCommentTree(commentListing, maxComments, post.author);

        return { post, comments, allocatedComments: maxComments, actualComments: post.commentCount };

      } catch (error) {
        lastError = classifyError(error);

        // Rate limited -- always retry with backoff
        const status = (error as Error & { status?: number }).status;
        if (status === 429) {
          const delay = REDDIT_CONFIG.RETRY_DELAYS[attempt] || 32000;
          console.warn(`[reddit] Rate limited. Retry ${attempt + 1}/${REDDIT_CONFIG.RETRY_COUNT} after ${delay}ms`);
          await sleep(delay);
          continue;
        }

        if (!lastError.retryable) {
          throw error instanceof Error ? error : new Error(lastError.message);
        }

        if (attempt < REDDIT_CONFIG.RETRY_COUNT - 1) {
          const delay = REDDIT_CONFIG.RETRY_DELAYS[attempt] || 2000;
          console.warn(`[reddit] ${lastError.code}: ${lastError.message}. Retry ${attempt + 1}/${REDDIT_CONFIG.RETRY_COUNT}`);
          await sleep(delay);
        }
      }
    }

    throw new Error(lastError?.message || 'Failed to fetch Reddit post after retries');
  }

  async getPosts(urls: string[], maxComments = 100, sort: CommentSort = 'top'): Promise<Map<string, PostResult | Error>> {
    if (urls.length <= REDDIT_CONFIG.BATCH_SIZE) {
      const results = await pMap(
        urls,
        u => this.getPost(u, maxComments, sort).catch(e => e as Error),
        5,
      );
      return new Map(urls.map((u, i) => [u, results[i]!]));
    }
    return (await this.batchGetPosts(urls, maxComments, true, undefined, sort)).results;
  }

  async batchGetPosts(
    urls: string[],
    maxCommentsOverride?: number,
    fetchComments = true,
    onBatchComplete?: (batchNum: number, totalBatches: number, processed: number) => void,
    sort: CommentSort = 'top',
  ): Promise<BatchPostResult> {
    const allResults = new Map<string, PostResult | Error>();
    let rateLimitHits = 0;

    const allocation = calculateCommentAllocation(urls.length);
    const initialPerPost = fetchComments ? (maxCommentsOverride || allocation.perPostCapped) : 0;

    // -- Phase 1: Fetch all posts with equal initial allocation --
    const totalBatches = Math.ceil(urls.length / REDDIT_CONFIG.BATCH_SIZE);
    console.warn(`[reddit] Phase 1: Fetching ${urls.length} posts in ${totalBatches} batch(es), ${initialPerPost} comments/post`);

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const startIdx = batchNum * REDDIT_CONFIG.BATCH_SIZE;
      const batchUrls = urls.slice(startIdx, startIdx + REDDIT_CONFIG.BATCH_SIZE);

      console.warn(`[reddit] Batch ${batchNum + 1}/${totalBatches} (${batchUrls.length} posts)`);

      const batchResult = await processBatch(this, batchUrls, initialPerPost, sort);
      for (const [url, result] of batchResult.results) {
        allResults.set(url, result);
      }
      rateLimitHits += batchResult.rateLimitHits;

      try {
        onBatchComplete?.(batchNum + 1, totalBatches, allResults.size);
      } catch (callbackError) {
        console.error(`[reddit] onBatchComplete callback error: ${callbackError}`);
      }

      console.warn(`[reddit] Batch ${batchNum + 1} complete (${allResults.size}/${urls.length})`);

      if (batchNum < totalBatches - 1) {
        await sleep(500);
      }
    }

    // -- Phase 2: Redistribute surplus to truncated posts --
    if (fetchComments && !maxCommentsOverride) {
      rateLimitHits += await redistributeComments(this, allResults, allocation, initialPerPost, sort);
    }

    return { results: allResults, batchesProcessed: totalBatches, totalPosts: urls.length, rateLimitHits, commentAllocation: allocation };
  }
}
