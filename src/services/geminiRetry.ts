/**
 * geminiRetry.ts — powered by @kevinsisi/ai-core withRetry
 *
 * Keeps the same public API as the old implementation.
 */

import { withRetry, NoAvailableKeyError } from '@kevinsisi/ai-core';
import { getGeminiApiKey, getGeminiApiKeyExcluding, markKeyBad } from './geminiKeys.js';

interface RetryOptions {
  maxRetries?: number;
  callType?: string;
  projectId?: string;
}

export async function withGeminiRetry<T>(
  fn: (apiKey: string) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const initialKey = getGeminiApiKey();
  if (!initialKey) throw new Error('No Gemini API key available');

  return withRetry(fn, initialKey, {
    maxRetries: options?.maxRetries ?? 3,
    rotateKey: async () => {
      const nextKey = getGeminiApiKeyExcluding(initialKey);
      if (!nextKey) throw new NoAvailableKeyError();
      return nextKey;
    },
    onRetry: (info) => {
      if (info.errorClass === 'quota' || info.errorClass === 'rate-limit') {
        markKeyBad(initialKey, '429');
      } else if (info.errorClass === 'fatal') {
        markKeyBad(initialKey, '403');
      }
      console.warn(`[geminiRetry] attempt ${info.attempt}/${info.maxRetries + 1}: ${info.errorClass}`);
    },
  });
}

export async function withStreamRetry(
  fn: (apiKey: string) => Promise<void>,
  options?: RetryOptions
): Promise<void> {
  return withGeminiRetry(fn, options);
}
