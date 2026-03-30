/**
 * LLM content extraction via Workers AI.
 * Uses GLM 4.7 Flash (primary) → GPT-OSS 120B (fallback).
 * Runs entirely on Cloudflare — no external API calls.
 */

import type { ResolvedEnv } from '../env.js';
import { classifyError, type StructuredError } from './errors.js';

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
 * Extract/summarize content using Workers AI.
 * Tries primary model, falls back to secondary on failure.
 * Returns original content if both fail (never throws).
 */
export async function extractWithWorkersAI(
  ai: Ai,
  content: string,
  instruction?: string,
  maxTokens?: number,
  env?: ResolvedEnv,
): Promise<ExtractionResult> {
  if (!content?.trim()) {
    return { content: content || '', processed: false, error: 'Empty content' };
  }

  const truncated = content.length > MAX_INPUT_CHARS
    ? content.substring(0, MAX_INPUT_CHARS) + '\n\n[Content truncated]'
    : content;

  const prompt = instruction
    ? `Extract and clean the following content. Focus on: ${instruction}\n\nContent:\n${truncated}`
    : `Clean and extract the main content from this text. Remove navigation, ads, and irrelevant elements. Return only the essential information:\n\n${truncated}`;

  const primaryModel = env?.LLM_EXTRACTION_MODEL || DEFAULT_MODEL;
  const fallbackModel = env?.LLM_EXTRACTION_FALLBACK_MODEL || DEFAULT_FALLBACK;

  // Try primary model
  const primaryResult = await runModel(ai, primaryModel, prompt, maxTokens);
  if (primaryResult.processed) {
    return primaryResult;
  }

  // Try fallback if different
  if (fallbackModel !== primaryModel) {
    console.warn(`Extraction primary (${primaryModel}) failed: ${primaryResult.error}. Trying fallback: ${fallbackModel}`);
    const fallbackResult = await runModel(ai, fallbackModel, prompt, maxTokens);
    if (fallbackResult.processed) {
      return fallbackResult;
    }
    console.error(`Extraction fallback (${fallbackModel}) also failed: ${fallbackResult.error}`);
  }

  // Both failed — return original content
  return { content, processed: false, error: primaryResult.error };
}

async function runModel(
  ai: Ai,
  model: string,
  prompt: string,
  maxTokens?: number,
): Promise<ExtractionResult> {
  try {
    const response = await ai.run(model as any, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens || 4096,
      temperature: 0.1,
    });

    // Workers AI returns { response: string } or { choices: [...] }
    let output = '';
    if (typeof response === 'string') {
      output = response;
    } else if ('response' in response && typeof response.response === 'string') {
      output = response.response;
    } else if ('choices' in response && Array.isArray(response.choices)) {
      output = (response.choices[0] as any)?.message?.content || '';
    }

    if (output?.trim()) {
      return { content: output, processed: true, model };
    }

    return { content: '', processed: false, model, error: 'Empty response from model' };
  } catch (err) {
    const structured = classifyError(err);
    return { content: '', processed: false, model, error: structured.message };
  }
}
