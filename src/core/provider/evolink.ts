import * as crypto from 'crypto';
import { redactSecrets } from '../security/redact';

export const DEFAULT_EVOLINK_BASE_URL = 'https://direct.evolink.ai/v1';

export type EvolinkClassification =
  | 'PASS'
  | 'CONFIGURATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'PROVIDER_ERROR';

export class EvolinkError extends Error {
  public readonly category: EvolinkClassification;
  public readonly statusCode?: number;

  constructor(message: string, category: EvolinkClassification, statusCode?: number) {
    super(redactSecrets(message));
    this.name = 'EvolinkError';
    this.category = category;
    this.statusCode = statusCode;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EvolinkQueryOptions {
  modelId: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export interface EvolinkQueryResult {
  content: string;
  latencyMs: number;
  inputHash: string;
  outputHash: string;
  model: string;
}

/**
 * Builds the chat completions endpoint URL from the given base URL.
 */
export function buildEvolinkUrl(baseUrl?: string): string {
  const base = (baseUrl || process.env.EVOLINK_BASE_URL || DEFAULT_EVOLINK_BASE_URL).trim();
  const normalized = base.replace(/\/+$/, '');
  return `${normalized}/chat/completions`;
}

/**
 * Resolves the API key strictly from options or process.env.
 * Throws CONFIGURATION_ERROR immediately if key is missing or empty.
 */
export function getEvolinkApiKey(providedKey?: string): string {
  const key = providedKey !== undefined ? providedKey : process.env.EVOLINK_API_KEY;
  if (!key || typeof key !== 'string' || key.trim() === '') {
    throw new EvolinkError(
      'EVOLINK_API_KEY environment variable is missing or empty',
      'CONFIGURATION_ERROR'
    );
  }
  return key.trim();
}

/**
 * Computes deterministic SHA-256 hash of an object or string.
 */
export function computeSha256(data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Invokes the EvoLink chat completions API for the specified model.
 */
export async function queryEvolink(options: EvolinkQueryOptions): Promise<EvolinkQueryResult> {
  const apiKey = getEvolinkApiKey(options.apiKey);
  const url = buildEvolinkUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 30000;
  const customFetch = options.fetchFn ?? fetch;

  const requestBody: Record<string, unknown> = {
    model: options.modelId,
    messages: options.messages,
    max_tokens: options.maxTokens ?? 256
  };
  if (options.temperature !== undefined) {
    requestBody.temperature = options.temperature;
  }

  const inputHash = computeSha256(options.messages);
  const startTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await customFetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const errMessage = (err as Error)?.message || String(err);
    if ((err as Error)?.name === 'AbortError' || errMessage.toLowerCase().includes('timeout') || errMessage.toLowerCase().includes('aborted')) {
      throw new EvolinkError(`Request timed out after ${timeoutMs}ms`, 'PROVIDER_ERROR');
    }
    throw new EvolinkError(`Network request failed: ${redactSecrets(errMessage)}`, 'PROVIDER_ERROR');
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - startTime;

  // HTTP 401/403: AUTHENTICATION_ERROR
  if (response.status === 401 || response.status === 403) {
    throw new EvolinkError(
      `Authentication failed (HTTP ${response.status})`,
      'AUTHENTICATION_ERROR',
      response.status
    );
  }

  // HTTP 402, 429, 5xx: PROVIDER_ERROR
  if (response.status === 402 || response.status === 429 || response.status >= 500) {
    throw new EvolinkError(
      `Provider error (HTTP ${response.status})`,
      'PROVIDER_ERROR',
      response.status
    );
  }

  if (!response.ok) {
    throw new EvolinkError(
      `Unexpected HTTP response ${response.status}`,
      'PROVIDER_ERROR',
      response.status
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new EvolinkError('Failed to parse JSON response from EvoLink', 'PROVIDER_ERROR');
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new EvolinkError('Malformed response: missing or empty choices array', 'PROVIDER_ERROR');
  }

  const firstChoice = data.choices[0];
  const content = firstChoice?.message?.content;
  if (typeof content !== 'string') {
    throw new EvolinkError('Malformed response: missing message.content in choice', 'PROVIDER_ERROR');
  }

  const outputHash = computeSha256(content);

  return {
    content,
    latencyMs,
    inputHash,
    outputHash,
    model: options.modelId
  };
}
