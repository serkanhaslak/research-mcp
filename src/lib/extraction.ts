/**
 * LLM content extraction — Workers AI (primary) or OpenRouter (fallback).
 * Unified interface: tools call extractContent() without knowing which backend runs.
 */

import type { ResolvedEnv } from '../env.js';
import { classifyError } from './errors.js';

const DEFAULT_MODEL = '@cf/zai-org/glm-4.7-flash';
const DEFAULT_FALLBACK = '@cf/openai/gpt-oss-120b';
const MAX_INPUT_CHARS = 100_000;

export interface ExtractionResult {
  content: string;
  processed: boolean;
  model?: string;
  error?: string;
}

/**
 * Extract/summarize content using the best available backend.
 * Priority: Workers AI (on-infra, cheap) → OpenRouter (external, fallback).
 * Returns original content if all backends fail (never throws).
 */
export async function extractContent(
  env: ResolvedEnv,
  content: string,
  instruction?: string,
  maxTokens?: number,
): Promise<ExtractionResult> {
  if (!content?.trim()) {
    return { content: content || '', processed: false, error: 'Empty content' };
  }

  if (env.AI) {
    return extractWithWorkersAI(env.AI, content, instruction, maxTokens, env);
  }

  if (env.OPENROUTER_API_KEY) {
    return extractWithOpenRouter(env, content, instruction, maxTokens);
  }

  return { content, processed: false, error: 'No extraction backend available (no AI binding or OPENROUTER_API_KEY)' };
}

// ── Workers AI path ──

async function extractWithWorkersAI(
  ai: Ai,
  content: string,
  instruction?: string,
  maxTokens?: number,
  env?: ResolvedEnv,
): Promise<ExtractionResult> {
  const prompt = buildPrompt(content, instruction);
  const primaryModel = env?.LLM_EXTRACTION_MODEL || DEFAULT_MODEL;
  const fallbackModel = env?.LLM_EXTRACTION_FALLBACK_MODEL || DEFAULT_FALLBACK;

  const primaryResult = await runWorkersAIModel(ai, primaryModel, prompt, maxTokens);
  if (primaryResult.processed) return primaryResult;

  if (fallbackModel !== primaryModel) {
    console.warn(`Workers AI primary (${primaryModel}) failed: ${primaryResult.error}. Trying fallback: ${fallbackModel}`);
    const fallbackResult = await runWorkersAIModel(ai, fallbackModel, prompt, maxTokens);
    if (fallbackResult.processed) return fallbackResult;
  }

  return { content, processed: false, error: primaryResult.error };
}

async function runWorkersAIModel(
  ai: Ai,
  model: string,
  prompt: string,
  maxTokens?: number,
): Promise<ExtractionResult> {
  try {
    const response = await ai.run(model as Parameters<Ai['run']>[0], {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens || 4096,
      temperature: 0.1,
    });

    let output = '';
    if (typeof response === 'string') {
      output = response;
    } else if ('response' in response && typeof response.response === 'string') {
      output = response.response;
    } else if ('choices' in response && Array.isArray(response.choices)) {
      const choice = response.choices[0] as { message?: { content?: string } } | undefined;
      output = choice?.message?.content || '';
    }

    if (output?.trim()) {
      return { content: output, processed: true, model };
    }
    return { content: '', processed: false, model, error: 'Empty response' };
  } catch (err) {
    return { content: '', processed: false, model, error: classifyError(err).message };
  }
}

// ── OpenRouter path (fallback for STDIO mode where no AI binding exists) ──

async function extractWithOpenRouter(
  env: ResolvedEnv,
  content: string,
  instruction?: string,
  maxTokens?: number,
): Promise<ExtractionResult> {
  // Dynamic import to avoid loading OpenAI SDK when Workers AI is available
  const { OpenRouterClient } = await import('../clients/openrouter.js');
  const client = new OpenRouterClient(env.OPENROUTER_API_KEY!, {
    extractionModel: env.LLM_EXTRACTION_MODEL,
  });
  return client.extract(content, instruction, maxTokens);
}

// ── Shared ──

function buildPrompt(content: string, instruction?: string): string {
  const truncated = content.length > MAX_INPUT_CHARS
    ? content.substring(0, MAX_INPUT_CHARS) + '\n\n[Content truncated]'
    : content;

  return instruction
    ? `Extract and clean the following content. Focus on: ${instruction}\n\nContent:\n${truncated}`
    : `Clean and extract the main content. Remove navigation, ads, irrelevant elements:\n\n${truncated}`;
}
