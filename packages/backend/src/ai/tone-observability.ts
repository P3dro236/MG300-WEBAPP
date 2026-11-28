import type { AiToneAmbienceDiagnostics } from '@quicktone/shared';
import { getSharedMidiDiagnosticsLogger, type MidiDiagnosticsLogger } from '@quicktone/midi';

export interface AiToneObservabilityOptions {
  logger?: MidiDiagnosticsLogger;
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 50;
const API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{16,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{12,}/gi;

export function redactSensitiveTokens(text: string): string {
  let out = text.replace(API_KEY_PATTERN, '[REDACTED]').replace(BEARER_PATTERN, 'Bearer [REDACTED]');
  const envSecrets = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2];
  for (const secret of envSecrets) {
    if (typeof secret === 'string' && secret.trim().length > 0) {
      out = out.split(secret.trim()).join('[REDACTED]');
    }
  }
  return out;
}

/**
 * Records structured ambience generation & calibration telemetry (excluding secrets/API keys)
 * both in memory for runtime inspection and into the shared diagnostic log.
 */
export class AiToneObservabilityRecorder {
  private readonly logger: MidiDiagnosticsLogger;
  private readonly maxEntries: number;
  private readonly entries: AiToneAmbienceDiagnostics[] = [];

  public constructor(options: AiToneObservabilityOptions = {}) {
    this.logger = options.logger ?? getSharedMidiDiagnosticsLogger();
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  public record(entry: AiToneAmbienceDiagnostics): AiToneAmbienceDiagnostics {
    const sanitized: AiToneAmbienceDiagnostics = {
      ...entry,
      originalPrompt: redactSensitiveTokens(entry.originalPrompt),
      delayDecisionReason: redactSensitiveTokens(entry.delayDecisionReason),
      warnings: entry.warnings.map((w) => redactSensitiveTokens(w)),
      corrections: entry.corrections.map((c) => ({
        ...c,
        reason: redactSensitiveTokens(c.reason),
        proposed: typeof c.proposed === 'string' ? redactSensitiveTokens(c.proposed) : c.proposed,
        applied: typeof c.applied === 'string' ? redactSensitiveTokens(c.applied) : c.applied,
      })),
    };

    this.entries.push(sanitized);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    this.logger.info('ai-tone', 'Ambience decision recorded', {
      originalPrompt: sanitized.originalPrompt,
      musicalPurpose: sanitized.musicalPurpose,
      delayProfile: sanitized.delayProfile,
      aiSuggestedProfile: sanitized.aiSuggestedProfile,
      delayDecision: sanitized.delayDecision,
      delayDecisionReason: sanitized.delayDecisionReason,
      selectedDelayModel: sanitized.selectedDelayModel,
      aiProposedAmbience: sanitized.aiProposedAmbience,
      finalAmbience: sanitized.finalAmbience,
      corrections: sanitized.corrections,
      warnings: sanitized.warnings,
    });

    return sanitized;
  }

  public getRecent(): AiToneAmbienceDiagnostics[] {
    return [...this.entries];
  }
}
