/**
 * Error handling utilities — NEVER crashes, always returns structured responses
 */

export const ErrorCode = {
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  AUTH_ERROR: 'AUTH_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

const MAX_ERROR_MSG_LENGTH = 500;

export interface StructuredError {
  code: ErrorCodeType;
  message: string;
  retryable: boolean;
  statusCode?: number;
  cause?: string;
}

// ── Backoff ──

const JITTER_FACTOR = 0.3;

export function calculateBackoff(
  attempt: number,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30000,
): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = JITTER_FACTOR * exponentialDelay * Math.random();
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

// ── Sleep ──

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    function onAbort() {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    const timeout = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

// ── Fetch with timeout ──

export function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let onExternalAbort: (() => void) | undefined;
  if (externalSignal) {
    onExternalAbort = () => controller.abort();
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal.aborted) controller.abort();
  }

  return fetch(url, { ...fetchOptions, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  });
}

// ── Error Classification ──

function classifyDomException(error: DOMException): StructuredError {
  if (error.name === 'AbortError') {
    return { code: ErrorCode.TIMEOUT, message: 'Request timed out', retryable: true };
  }
  return { code: ErrorCode.UNKNOWN_ERROR, message: error.message.substring(0, MAX_ERROR_MSG_LENGTH), retryable: false };
}

function classifyByErrorCode(error: { code?: string; message?: string }): StructuredError | null {
  const errCode = error.code;
  if (!errCode) return null;
  if (errCode === 'ECONNREFUSED' || errCode === 'ENOTFOUND' || errCode === 'ECONNRESET') {
    return { code: ErrorCode.NETWORK_ERROR, message: 'Network connection failed', retryable: true, cause: error.message };
  }
  if (errCode === 'ECONNABORTED' || errCode === 'ETIMEDOUT') {
    return { code: ErrorCode.TIMEOUT, message: 'Request timed out', retryable: true, cause: error.message };
  }
  return null;
}

function classifyByStatusCode(error: { status?: number; statusCode?: number; response?: { status?: number }; message?: string }): StructuredError | null {
  const status = error.response?.status || error.status || error.statusCode;
  if (!status) return null;
  return classifyHttpError(status, error.message || String(error));
}

function classifyByMessage(message: string): StructuredError | null {
  const lower = message.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborterror')) {
    return { code: ErrorCode.TIMEOUT, message: 'Request timed out', retryable: true, cause: message };
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return { code: ErrorCode.RATE_LIMITED, message: 'Rate limit exceeded', retryable: true, cause: message };
  }
  if (message.includes('API_KEY') || message.includes('api_key') || message.includes('Invalid API')) {
    return { code: ErrorCode.AUTH_ERROR, message: 'API key missing or invalid', retryable: false, cause: message };
  }
  if (message.includes('JSON') || message.includes('parse') || message.includes('Unexpected token')) {
    return { code: ErrorCode.PARSE_ERROR, message: 'Failed to parse response', retryable: false, cause: message };
  }
  return null;
}

function isErrorLike(value: unknown): value is {
  message?: string; response?: { status?: number }; status?: number; statusCode?: number; code?: string; cause?: unknown;
} {
  return typeof value === 'object' && value !== null;
}

export function classifyError(error: unknown): StructuredError {
  if (error == null) {
    return { code: ErrorCode.UNKNOWN_ERROR, message: 'An unknown error occurred', retryable: false };
  }
  if (error instanceof DOMException) return classifyDomException(error);
  if (!isErrorLike(error)) {
    return { code: ErrorCode.UNKNOWN_ERROR, message: String(error).substring(0, MAX_ERROR_MSG_LENGTH), retryable: false };
  }
  return classifyByErrorCode(error)
    ?? classifyByStatusCode(error)
    ?? classifyByMessage(error.message ?? String(error))
    ?? { code: ErrorCode.UNKNOWN_ERROR, message: (error.message ?? String(error)).substring(0, MAX_ERROR_MSG_LENGTH), retryable: false };
}

function classifyHttpError(status: number, message: string): StructuredError {
  switch (status) {
    case 400: return { code: ErrorCode.INVALID_INPUT, message: 'Bad request', retryable: false, statusCode: status };
    case 401: return { code: ErrorCode.AUTH_ERROR, message: 'Invalid API key', retryable: false, statusCode: status };
    case 403: return { code: ErrorCode.QUOTA_EXCEEDED, message: 'Access forbidden or quota exceeded', retryable: false, statusCode: status };
    case 404: return { code: ErrorCode.NOT_FOUND, message: 'Resource not found', retryable: false, statusCode: status };
    case 408: return { code: ErrorCode.TIMEOUT, message: 'Request timeout', retryable: true, statusCode: status };
    case 429: return { code: ErrorCode.RATE_LIMITED, message: 'Rate limit exceeded', retryable: true, statusCode: status };
    case 500: return { code: ErrorCode.INTERNAL_ERROR, message: 'Server error', retryable: true, statusCode: status };
    case 502: return { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'Bad gateway', retryable: true, statusCode: status };
    case 503: return { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'Service unavailable', retryable: true, statusCode: status };
    case 504: return { code: ErrorCode.TIMEOUT, message: 'Gateway timeout', retryable: true, statusCode: status };
    default:
      if (status >= 500) return { code: ErrorCode.SERVICE_UNAVAILABLE, message: `Server error: ${status}`, retryable: true, statusCode: status };
      if (status >= 400) return { code: ErrorCode.INVALID_INPUT, message: `Client error: ${status}`, retryable: false, statusCode: status };
      return { code: ErrorCode.UNKNOWN_ERROR, message: `HTTP ${status}: ${message.substring(0, MAX_ERROR_MSG_LENGTH)}`, retryable: false, statusCode: status };
  }
}

// ── Stability Wrappers ──

export function withRequestTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string = 'request',
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fn(controller.signal).finally(() => clearTimeout(timeoutId)).catch((err) => {
    if (controller.signal.aborted && err instanceof DOMException && err.name === 'AbortError') {
      throw Object.assign(new Error('Request timed out — please try again'), { code: 'ETIMEDOUT', retryable: true });
    }
    throw err;
  });
}

export async function withStallProtection<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  stallMs: number,
  maxAttempts: number = 2,
  label: string = 'request',
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const stallPromise = new Promise<never>((_, reject) => {
      stallTimer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error(`Service temporarily unavailable — no response received (attempt ${attempt + 1}/${maxAttempts})`), {
          code: 'ESTALLED', retryable: attempt < maxAttempts - 1,
        }));
      }, stallMs);
    });

    let fnPromise: Promise<T> | undefined;
    try {
      fnPromise = fn(controller.signal);
      const result = await Promise.race([fnPromise, stallPromise]);
      clearTimeout(stallTimer);
      return result;
    } catch (err) {
      fnPromise?.catch(() => {});
      clearTimeout(stallTimer);
      const isStall = err instanceof Error && (err as any).code === 'ESTALLED';
      if (isStall && attempt < maxAttempts - 1) {
        const backoff = calculateBackoff(attempt);
        console.warn(`${label} stalled, retrying in ${backoff}ms (attempt ${attempt + 1})`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} stall-protection attempts`);
}

// ── MCP Tool Error Responses ──

export function createToolErrorFromStructured(structuredError: StructuredError): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const retryHint = structuredError.retryable
    ? '\n\n**This error is temporary.** Wait a moment and try again.'
    : '';
  const errorText = `## Error\n\n**${structuredError.code}:** ${structuredError.message}${retryHint}`;
  return { content: [{ type: 'text', text: errorText }], isError: true };
}
