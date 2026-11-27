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
}

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
      parts?: Array<{ text?: string }>;
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

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL_CACHE_TTL_MS = 600_000;
export const SAFE_FALLBACK_GEMINI_MODELS: readonly string[] = [
  'models/gemini-2.5-pro',
  'models/gemini-2.5-flash',
  'models/gemini-2.0-flash',
];

const EXCLUDED_MODEL_PATTERNS = [
  'embedding',
  'imagen',
  'veo',
  'tts',
  'audio',
  'aqa',
  'robotics',
  'computer-use',
  'gemma',
] as const;

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

interface ModelSortRank {
  major: number;
  minor: number;
  tier: number; // 3=pro, 2=flash, 1=flash-lite, 0=other
  stable: number; // 1=stable, 0=preview/exp
}

function getModelSortRank(modelName: string): ModelSortRank {
  const lower = modelName.toLowerCase();
  const verMatch = /gemini-(\d+)(?:\.(\d+))?/.exec(lower);
  const major = verMatch?.[1] ? Number.parseInt(verMatch[1], 10) : 0;
  const minor = verMatch?.[2] ? Number.parseInt(verMatch[2], 10) : 0;

  let tier = 0;
  if (lower.includes('flash-lite') || lower.includes('-lite') || lower.includes('-8b')) {
    tier = 1;
  } else if (lower.includes('flash')) {
    tier = 2;
  } else if (lower.includes('pro')) {
    tier = 3;
  }

  const isUnstable =
    lower.includes('preview') || lower.includes('-exp') || lower.includes('experimental');
  return {
    major,
    minor,
    tier,
    stable: isUnstable ? 0 : 1,
  };
}

export function selectAndRankGeminiModels(models: readonly GoogleModelInfo[]): string[] {
  const filtered = models
    .filter((model): model is { name: string; supportedGenerationMethods: string[] } => {
      if (typeof model.name !== 'string' || !model.name.trim()) {
        return false;
      }
      if (!Array.isArray(model.supportedGenerationMethods)) {
        return false;
      }
      if (!model.supportedGenerationMethods.includes('generateContent')) {
        return false;
      }
      const lower = model.name.toLowerCase();
      if (!lower.includes('gemini')) {
        return false;
      }
      return !EXCLUDED_MODEL_PATTERNS.some((pattern) => lower.includes(pattern));
    })
    .map((model) => (model.name.startsWith('models/') ? model.name : `models/${model.name}`));

  const unique = Array.from(new Set(filtered));
  unique.sort((a, b) => {
    const rankA = getModelSortRank(a);
    const rankB = getModelSortRank(b);
    if (rankA.major !== rankB.major) return rankB.major - rankA.major;
    if (rankA.minor !== rankB.minor) return rankB.minor - rankA.minor;
    if (rankA.tier !== rankB.tier) return rankB.tier - rankA.tier;
    if (rankA.stable !== rankB.stable) return rankB.stable - rankA.stable;
    return a.localeCompare(b);
  });

  return unique;
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
    upper.includes('TOKEN')
  );
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
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
  private readonly modelCache = new Map<string, CachedModelList>();

  public constructor(options: GeminiClientOptions = {}) {
    this.explicitKeys = options.apiKeys;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.modelCacheTtlMs = options.modelCacheTtlMs ?? resolveDefaultCacheTtlMs();
    this.nowFn = options.nowFn ?? Date.now;
    this.baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  }

  private resolveApiKeys(): string[] {
    const rawKeys = this.explicitKeys ?? [
      process.env.GEMINI_API_KEY ?? '',
      process.env.GEMINI_API_KEY_2 ?? '',
    ];
    const deduped: string[] = [];
    for (const raw of rawKeys) {
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      if (trimmed.length > 0 && !deduped.includes(trimmed)) {
        deduped.push(trimmed);
      }
    }
    return deduped;
  }

  public async listModelsForKey(apiKey: string): Promise<string[]> {
    const now = this.nowFn();
    const cached = this.modelCache.get(apiKey);
    if (cached && cached.expiresAt > now) {
      return cached.models;
    }

    try {
      const response = await this.fetchFn(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return [...SAFE_FALLBACK_GEMINI_MODELS];
      }

      const payload = (await response.json()) as GoogleListModelsResponse;
      const ranked = selectAndRankGeminiModels(payload.models ?? []);
      if (ranked.length === 0) {
        return [...SAFE_FALLBACK_GEMINI_MODELS];
      }

      this.modelCache.set(apiKey, {
        models: ranked,
        expiresAt: now + this.modelCacheTtlMs,
      });
      return ranked;
    } catch {
      return [...SAFE_FALLBACK_GEMINI_MODELS];
    }
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
      const models = await this.listModelsForKey(apiKey);
      for (const model of models) {
        const modelPath = model.startsWith('models/') ? model : `models/${model}`;
        const url = `${this.baseUrl}/${modelPath}:generateContent`;

        const generationConfig: Record<string, unknown> = {
          responseMimeType: 'application/json',
        };
        if (options.responseSchema) {
          generationConfig.responseSchema = options.responseSchema;
        }
        if (options.temperature !== undefined) {
          generationConfig.temperature = options.temperature;
        }
        if (options.maxOutputTokens !== undefined) {
          generationConfig.maxOutputTokens = options.maxOutputTokens;
        }

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
          generationConfig,
        };

        try {
          const response = await this.fetchFn(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
          });

          const rawBody = await response.text();
          if (!response.ok) {
            if (isQuotaErrorSignal(response.status, rawBody)) {
              sawQuotaError = true;
            }
            lastErrorDetail = sanitizeSecretStrings(
              `HTTP ${response.status} (${modelPath})`,
              apiKeys,
            );
            if (isRetryableStatus(response.status)) {
              continue;
            }
            continue;
          }

          let parsedPayload: GoogleGenerateContentResponse;
          try {
            parsedPayload = JSON.parse(rawBody) as GoogleGenerateContentResponse;
          } catch {
            lastErrorDetail = `Invalid JSON envelope from ${modelPath}`;
            continue;
          }

          if (parsedPayload.error) {
            const errMsg = JSON.stringify(parsedPayload.error);
            if (isQuotaErrorSignal(parsedPayload.error.code ?? 500, errMsg)) {
              sawQuotaError = true;
            }
            lastErrorDetail = sanitizeSecretStrings(
              parsedPayload.error.message ?? errMsg,
              apiKeys,
            );
            continue;
          }

          const parts = parsedPayload.candidates?.[0]?.content?.parts ?? [];
          const text = parts
            .map((p) => (typeof p.text === 'string' ? p.text : ''))
            .join('')
            .trim();
          if (!text) {
            lastErrorDetail = `Empty response from ${modelPath}`;
            continue;
          }

          try {
            return JSON.parse(extractJsonText(text)) as T;
          } catch {
            lastErrorDetail = `Malformed JSON output from ${modelPath}`;
            continue;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          lastErrorDetail = sanitizeSecretStrings(message, apiKeys);
          continue;
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
