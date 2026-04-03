import { getGeminiApiKey, getGeminiApiKeyExcluding, markKeyBad } from './geminiKeys';

interface RetryOptions {
  maxRetries?: number;
  callType?: string;
  projectId?: string;
}

export async function withGeminiRetry<T>(
  fn: (apiKey: string) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  let currentKey = getGeminiApiKey();
  if (!currentKey) throw new Error('No Gemini API key available');

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(currentKey);
    } catch (err: any) {
      lastError = err;
      const msg = (err?.message || '').toLowerCase();
      const status = err?.status || err?.httpCode || 0;

      const is429 = status === 429 || msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate');
      const isAuth = status === 401 || status === 403 || msg.includes('401') || msg.includes('403') || msg.includes('api_key_invalid') || msg.includes('permission');
      const isServer = status === 500 || status === 503 || msg.includes('500') || msg.includes('503') || msg.includes('internal');

      if (attempt === maxRetries) break;

      if (is429) {
        markKeyBad(currentKey, '429');
        const nextKey = getGeminiApiKeyExcluding(currentKey);
        if (nextKey) {
          currentKey = nextKey;
          console.warn(`[retry] 429, rotating key (attempt ${attempt + 1}/${maxRetries})`);
        } else {
          await sleep(2000);
        }
      } else if (isAuth) {
        markKeyBad(currentKey, status === 401 ? '401' : '403');
        const nextKey = getGeminiApiKeyExcluding(currentKey);
        if (nextKey) {
          currentKey = nextKey;
        } else {
          break;
        }
      } else if (isServer) {
        markKeyBad(currentKey, 'server_error');
        await sleep(1000);
      } else {
        break;
      }
    }
  }

  throw lastError || new Error('withGeminiRetry: all attempts failed');
}

export async function withStreamRetry(
  fn: (apiKey: string) => Promise<void>,
  options?: RetryOptions
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 2;
  let currentKey = getGeminiApiKey();
  if (!currentKey) throw new Error('No Gemini API key available');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn(currentKey);
      return;
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();
      const is429 = msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate');
      const isAuth = msg.includes('401') || msg.includes('403') || msg.includes('api_key_invalid');

      if (attempt === maxRetries) throw err;

      if (is429 || isAuth) {
        const reason = is429 ? '429' : '403';
        markKeyBad(currentKey, reason);
        const nextKey = getGeminiApiKeyExcluding(currentKey);
        if (nextKey) {
          currentKey = nextKey;
        } else if (is429) {
          await sleep(2000);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
