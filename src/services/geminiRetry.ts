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

  let currentKey = initialKey;

  try {
    return await withRetry(fn, initialKey, {
      maxRetries: options?.maxRetries ?? 3,
      rotateKey: async () => {
        const nextKey = getGeminiApiKeyExcluding(currentKey);
        if (!nextKey) throw new NoAvailableKeyError();
        currentKey = nextKey;
        return nextKey;
      },
      onRetry: (info) => {
        if (info.errorClass === 'quota' || info.errorClass === 'rate-limit') {
          markKeyBad(currentKey, '429');
        } else if (info.errorClass === 'fatal') {
          markKeyBad(currentKey, '403');
        }
        console.warn(`[geminiRetry] attempt ${info.attempt}/${info.maxRetries + 1}: ${info.errorClass}`);
      },
    });
  } catch (err: any) {
    const message = String(err?.message || err || '');
    if (message.includes('503') || message.includes('high demand') || message.includes('Service Unavailable')) {
      throw new Error('Gemini 目前流量較高，稍後再試即可。若部分平台已成功生成，內容會保留。');
    }
    if (message.includes('NoAvailableKeyError') || message.includes('No Gemini API key available')) {
      throw new Error('目前沒有可用的 Gemini key，請到設定頁檢查 API keys。');
    }
    throw err;
  }
}

export async function withStreamRetry(
  fn: (apiKey: string) => Promise<void>,
  options?: RetryOptions
): Promise<void> {
  return withGeminiRetry(fn, options);
}
