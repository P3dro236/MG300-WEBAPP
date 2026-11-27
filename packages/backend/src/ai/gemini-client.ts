import { loadEnvFiles } from '../env.js';

export class AiServiceError extends Error {
  public readonly timestamp: string;

  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 503,
  ) {
    super(message);
    this.name = 'AiServiceError';
    this.timestamp = new Date().toISOString();
  }
}

export type FetchLike = typeof fetch;

export interface GeminiGenerateJsonOptions {
  systemInstruction: string;
  userPrompt: string;
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingBudget?: number;
  timeoutMs?: number;
}

export interface GeminiClientLike {
  generateJson<T>(options: GeminiGenerateJsonOptions): Promise<T>;
}

export interface GeminiClientOptions {
  apiKeys?: readonly string[];
  fetchFn?: FetchLike;
  modelCacheTtlMs?: number;
  nowFn?: () => number;
  baseUrl?: string;
  autoLoadEnv?: boolean;
  loadEnvFn?: () => string[];
}

export type ListModelsResult =
  | { status: 'ok'; models: string[] }
  | { status: 'fallback'; models: string[] }
  | { status: 'auth_failed'; models: []; statusCode: 401 | 403 };

interface GoogleModelInfo {
  name?: string;
  supportedGenerationMethods?: string[];
}

interface GoogleListModelsResponse {
  models?: GoogleModelInfo[];
}

interface GoogleGenerateContentResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface CachedModelList {
  models: string[];
  expiresAt: number;
}

type ModelAttemptOutcome<T> =
  | { status: 'success'; value: T }
  | { status: 'failed'; quotaError: boolean; authFailed?: boolean; detail: string };

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL_CACHE_TTL_MS = 600_000;
export const DEFAULT_GEMINI_TIMEOUT_MS = 12_000;
const DEFAULT_LIST_MODELS_TIMEOUT_MS = 10_000;

export const ALLOWED_GEMINI_MODELS: readonly string[] = [
  'models/gemini-3.8-flash',
  'models/gemini-3.6-flash',
  'models/gemini-4-hydrogen',
  'models/gemini-3.5-flash-lite',
];

export const SAFE_FALLBACK_GEMINI_MODELS: readonly string[] = [...ALLOWED_GEMINI_MODELS];

const ALLOWED_MODEL_RANK = new Map<string, number>(
  ALLOWED_GEMINI_MODELS.map((model, index) => [model, index]),
);

const FLASH_OR_LITE_MODELS = new Set<string>([
  'models/gemini-3.8-flash',
  'models/gemini-3.6-flash',
  'models/gemini-3.5-flash-lite',
]);

function normalizeModelName(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith('models/') ? trimmed : `models/${trimmed}`;
}

function sanitizeSecretStrings(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

function resolveDefaultCacheTtlMs(): number {
  const raw = process.env.GEMINI_MODEL_CACHE_TTL_MS;
  if (!raw) {
    return DEFAULT_GEMINI_MODEL_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GEMINI_MODEL_CACHE_TTL_MS;
}

export function selectAndRankGeminiModels(models: readonly GoogleModelInfo[]): string[] {
  const allowed: string[] = [];

  for (const model of models) {
    if (typeof model.name !== 'string' || model.name.trim().length === 0) {
      continue;
    }
    if (
      !Array.isArray(model.supportedGenerationMethods) ||
      !model.supportedGenerationMethods.includes('generateContent')
    ) {
      continue;
    }
    const normalized = normalizeModelName(model.name);
    if (ALLOWED_MODEL_RANK.has(normalized)) {
      allowed.push(normalized);
    }
  }

  const unique = Array.from(new Set(allowed));
  unique.sort((a, b) => (ALLOWED_MODEL_RANK.get(a) ?? 0) - (ALLOWED_MODEL_RANK.get(b) ?? 0));
  return unique;
}

function resolveInitialThinkingBudget(
  modelPath: string,
  requestedBudget: number | undefined,
): number | undefined {
  if (requestedBudget !== undefined) {
    return requestedBudget;
  }
  return FLASH_OR_LITE_MODELS.has(modelPath) ? 0 : undefined;
}

const FALLBACK_THINKING_MIN_OUTPUT_TOKENS = 2048;

function buildGenerationConfig(
  options: GeminiGenerateJsonOptions,
  includeResponseSchema: boolean,
  thinkingBudget: number | undefined,
  maxOutputTokensOverride?: number,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
  };
  if (includeResponseSchema && options.responseSchema !== undefined) {
    generationConfig.responseSchema = options.responseSchema;
  }
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }
  const effectiveMaxOutputTokens = maxOutputTokensOverride ?? options.maxOutputTokens;
  if (effectiveMaxOutputTokens !== undefined) {
    generationConfig.maxOutputTokens = effectiveMaxOutputTokens;
  }
  if (thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget };
  }
  return generationConfig;
}

function isUnsupportedThinkingConfigError(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return (
    lower.includes('thinkingconfig') ||
    lower.includes('thinking_config') ||
    lower.includes('thinkingbudget') ||
    lower.includes('thinking_budget') ||
    (lower.includes('thinking') &&
      (lower.includes('not supported') ||
        lower.includes('unsupported') ||
        lower.includes('unknown') ||
        lower.includes('invalid') ||
        lower.includes('required') ||
        lower.includes('disabled') ||
        lower.includes('thinking mode')))
  );
}

function isUnsupportedResponseSchemaError(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return (
    lower.includes('responseschema') ||
    lower.includes('response_schema') ||
    lower.includes('schema')
  );
}

function isQuotaErrorSignal(status: number, bodyText: string): boolean {
  if (status === 429) {
    return true;
  }
  const upper = bodyText.toUpperCase();
  return (
    upper.includes('RESOURCE_EXHAUSTED') ||
    upper.includes('QUOTA') ||
    upper.includes('RATE_LIMIT') ||
    upper.includes('RATE LIMIT') ||
    upper.includes('TOKENS PER MINUTE') ||
    upper.includes('TOKEN_QUOTA') ||
    upper.includes('TOKEN QUOTA')
  );
}

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  return trimmed;
}

export class GeminiClient implements GeminiClientLike {
  private readonly explicitKeys: readonly string[] | undefined;
  private readonly fetchFn: FetchLike;
  private readonly modelCacheTtlMs: number;
  private readonly nowFn: () => number;
  private readonly baseUrl: string;
  private readonly autoLoadEnv: boolean;
  private readonly customLoadEnvFn: (() => string[]) | undefined;
  private readonly modelCache = new Map<string, CachedModelList>();

  public constructor(options: GeminiClientOptions = {}) {
    this.explicitKeys = options.apiKeys;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.modelCacheTtlMs = options.modelCacheTtlMs ?? resolveDefaultCacheTtlMs();
    this.nowFn = options.nowFn ?? Date.now;
    this.baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
    this.autoLoadEnv = options.autoLoadEnv ?? true;
    this.customLoadEnvFn = options.loadEnvFn;
  }

  private dedupeKeys(rawKeys: readonly string[]): string[] {
    const deduped: string[] = [];
    for (const raw of rawKeys) {
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      if (trimmed.length > 0 && !deduped.includes(trimmed)) {
        deduped.push(trimmed);
      }
    }
    return deduped;
  }

  private readEnvKeys(): string[] {
    return this.dedupeKeys([
      process.env.GEMINI_API_KEY ?? '',
      process.env.GEMINI_API_KEY_2 ?? '',
    ]);
  }

  private resolveApiKeys(): string[] {
    if (this.explicitKeys !== undefined) {
      return this.dedupeKeys(this.explicitKeys);
    }

    const fromEnv = this.readEnvKeys();
    if (fromEnv.length > 0) {
      return fromEnv;
    }

    // Avoid loading the user's real .env during test runs unless a custom loader was explicitly injected
    const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
    if (this.autoLoadEnv && (this.customLoadEnvFn !== undefined || !isTestEnv)) {
      (this.customLoadEnvFn ?? loadEnvFiles)();
      return this.readEnvKeys();
    }

    return [];
  }

  public async listModelsForKey(apiKey: string): Promise<ListModelsResult> {
    const now = this.nowFn();
    const cached = this.modelCache.get(apiKey);
    if (cached && cached.expiresAt > now) {
      return { status: 'ok', models: cached.models };
    }

    try {
      const response = await this.fetchFn(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey,
        },
        signal: AbortSignal.timeout(DEFAULT_LIST_MODELS_TIMEOUT_MS),
      });

      if (response.status === 401 || response.status === 403) {
        this.modelCache.delete(apiKey);
        return { status: 'auth_failed', models: [], statusCode: response.status };
      }

      if (!response.ok) {
        return { status: 'fallback', models: [...SAFE_FALLBACK_GEMINI_MODELS] };
      }

      const payload = (await response.json()) as GoogleListModelsResponse;
      const ranked = selectAndRankGeminiModels(payload.models ?? []);
      if (ranked.length === 0) {
        return { status: 'fallback', models: [...SAFE_FALLBACK_GEMINI_MODELS] };
      }

      this.modelCache.set(apiKey, {
        models: ranked,
        expiresAt: now + this.modelCacheTtlMs,
      });
      return { status: 'ok', models: ranked };
    } catch {
      return { status: 'fallback', models: [...SAFE_FALLBACK_GEMINI_MODELS] };
    }
  }

  private async attemptGenerateWithModel<T>(
    apiKey: string,
    modelPath: string,
    options: GeminiGenerateJsonOptions,
    secretsToRedact: readonly string[],
  ): Promise<ModelAttemptOutcome<T>> {
    const url = `${this.baseUrl}/${modelPath}:generateContent`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;

    let thinkingBudget = resolveInitialThinkingBudget(modelPath, options.thinkingBudget);
    let includeResponseSchema = options.responseSchema !== undefined;
    let maxOutputTokensOverride: number | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestBody = {
        systemInstruction: {
          parts: [{ text: options.systemInstruction }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: options.userPrompt }],
          },
        ],
        generationConfig: buildGenerationConfig(
          options,
          includeResponseSchema,
          thinkingBudget,
          maxOutputTokensOverride,
        ),
      };

      try {
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(timeoutMs),
        });

        const rawBody = await response.text();
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            return {
              status: 'failed',
              quotaError: false,
              authFailed: true,
              detail: sanitizeSecretStrings(`HTTP ${response.status} (${modelPath})`, secretsToRedact),
            };
          }

          if (response.status === 400) {
            const unsupportedThinking =
              thinkingBudget !== undefined && isUnsupportedThinkingConfigError(rawBody);
            const unsupportedSchema =
              includeResponseSchema && isUnsupportedResponseSchemaError(rawBody);

            if (unsupportedThinking || unsupportedSchema) {
              if (unsupportedThinking) {
                thinkingBudget = undefined;
                if (options.maxOutputTokens !== undefined) {
                  maxOutputTokensOverride = Math.max(
                    options.maxOutputTokens,
                    FALLBACK_THINKING_MIN_OUTPUT_TOKENS,
                  );
                }
              }
              if (unsupportedSchema) {
                includeResponseSchema = false;
              }
              continue;
            }
          }

          return {
            status: 'failed',
            quotaError: isQuotaErrorSignal(response.status, rawBody),
            detail: sanitizeSecretStrings(`HTTP ${response.status} (${modelPath})`, secretsToRedact),
          };
        }

        let parsedPayload: GoogleGenerateContentResponse;
        try {
          parsedPayload = JSON.parse(rawBody) as GoogleGenerateContentResponse;
        } catch {
          return {
            status: 'failed',
            quotaError: false,
            detail: `Invalid JSON envelope from ${modelPath}`,
          };
        }

        if (parsedPayload.error) {
          const errMsg = JSON.stringify(parsedPayload.error);
          return {
            status: 'failed',
            quotaError: isQuotaErrorSignal(parsedPayload.error.code ?? 500, errMsg),
            detail: sanitizeSecretStrings(
              parsedPayload.error.message ?? errMsg,
              secretsToRedact,
            ),
          };
        }

        const parts = parsedPayload.candidates?.[0]?.content?.parts ?? [];
        const nonThoughtParts = parts.filter((p) => p.thought !== true);
        const effectiveParts = nonThoughtParts.length > 0 ? nonThoughtParts : parts;
        const text = effectiveParts
          .map((p) => (typeof p.text === 'string' ? p.text : ''))
          .join('')
          .trim();
        if (!text) {
          return {
            status: 'failed',
            quotaError: false,
            detail: `Empty response from ${modelPath}`,
          };
        }

        try {
          return {
            status: 'success',
            value: JSON.parse(extractJsonText(text)) as T,
          };
        } catch {
          return {
            status: 'failed',
            quotaError: false,
            detail: `Malformed JSON output from ${modelPath}`,
          };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'failed',
          quotaError: false,
          detail: sanitizeSecretStrings(message, secretsToRedact),
        };
      }
    }

    return {
      status: 'failed',
      quotaError: false,
      detail: `Retry budget exhausted (${modelPath})`,
    };
  }

  public async generateJson<T>(options: GeminiGenerateJsonOptions): Promise<T> {
    const apiKeys = this.resolveApiKeys();
    if (apiKeys.length === 0) {
      throw new AiServiceError(
        'AI_KEYS_MISSING',
        'Nenhuma chave GEMINI_API_KEY configurada. Defina GEMINI_API_KEY no arquivo .env.',
        503,
      );
    }

    let sawQuotaError = false;
    let lastErrorDetail = '';

    for (const apiKey of apiKeys) {
      const discovery = await this.listModelsForKey(apiKey);
      if (discovery.status === 'auth_failed') {
        lastErrorDetail = sanitizeSecretStrings(
          `HTTP ${discovery.statusCode} (models)`,
          apiKeys,
        );
        continue;
      }

      for (const model of discovery.models) {
        const modelPath = normalizeModelName(model);
        const outcome = await this.attemptGenerateWithModel<T>(
          apiKey,
          modelPath,
          options,
          apiKeys,
        );

        if (outcome.status === 'success') {
          return outcome.value;
        }

        if (outcome.quotaError) {
          sawQuotaError = true;
        }
        lastErrorDetail = outcome.detail;
        if (outcome.authFailed) {
          this.modelCache.delete(apiKey);
          break;
        }
      }
    }

    if (sawQuotaError) {
      throw new AiServiceError(
        'AI_QUOTA_EXHAUSTED',
        'A cota das chaves Gemini configuradas foi excedida temporariamente. Tente novamente em instantes.',
        429,
      );
    }

    throw new AiServiceError(
      'AI_UNAVAILABLE',
      lastErrorDetail
        ? `Serviço de IA indisponível no momento (${lastErrorDetail}).`
        : 'Serviço de IA indisponível no momento.',
      503,
    );
  }
}
