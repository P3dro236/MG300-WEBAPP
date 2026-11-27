import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  type AiGearConfig,
  AiGearConfigSchema,
  type UpdateAiGearRequest,
} from '@quicktone/shared';
import { AiServiceError, type GeminiClientLike } from './gemini-client.js';

const GuitarValidationPayloadSchema = z.object({
  recognized: z.boolean(),
  normalizedModel: z.string().optional().default(''),
  pickupSummary: z.string().optional().default(''),
  recommendations: z.array(z.string()).optional().default([]),
  reason: z.string().optional().default(''),
});

const GEAR_VALIDATION_SYSTEM_INSTRUCTION = [
  'Você é um especialista técnico em guitarras elétricas, violões, contrabaixos e na pedaleira NUX MG-300.',
  'Sua tarefa é validar se o modelo informado pelo músico é um instrumento real ou configuração reconhecível de guitarra/violão/baixo.',
  'Rejeite textos aleatórios, sem sentido, ofensivos ou itens que não sejam instrumentos musicais (recognized: false).',
  'Aceite modelos comerciais reais (ex.: Fender Stratocaster, Gibson Les Paul, Ibanez RG, Tagima TG-530, PRS SE, Epiphone SG, Telecaster) e configurações claras (ex.: Strato HSS, Superstrato HH, Les Paul P90).',
  'Responda exclusivamente em JSON válido seguindo o formato solicitado.',
].join(' ');

export interface AiGearStoreOptions {
  filePath: string;
  geminiClient: GeminiClientLike;
}

export class AiGearStore {
  private readonly filePath: string;
  private readonly geminiClient: GeminiClientLike;

  public constructor(options: AiGearStoreOptions) {
    this.filePath = path.resolve(options.filePath);
    this.geminiClient = options.geminiClient;
  }

  public getGear(): AiGearConfig | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = AiGearConfigSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  public async validateAndSaveGear(input: UpdateAiGearRequest): Promise<AiGearConfig> {
    const guitarModel = input.guitarModel.trim();
    const outputTarget = input.outputTarget.trim();

    const userPrompt = JSON.stringify({
      task: 'validate_musician_gear',
      guitarModel,
      outputTarget: outputTarget || null,
      expectedJsonSchema: {
        recognized: 'boolean (true se for guitarra/violao/baixo real ou configuracao reconhecivel)',
        normalizedModel: 'string (nome limpo do modelo)',
        pickupSummary: 'string curta em pt-BR descrevendo os captadores tipicos (ex: HSS, HH, SSS, Piezo)',
        recommendations: 'array de 1 a 3 strings curtas em pt-BR com dicas de EQ/IR/ganho para a NUX MG-300 considerando a guitarra e a saida',
        reason: 'string em pt-BR explicando por que nao foi reconhecido quando recognized=false',
      },
    });

    const rawResponse = await this.geminiClient.generateJson<unknown>({
      systemInstruction: GEAR_VALIDATION_SYSTEM_INSTRUCTION,
      userPrompt,
      temperature: 0.2,
      maxOutputTokens: 512,
    });

    const validated = GuitarValidationPayloadSchema.safeParse(rawResponse);
    if (!validated.success) {
      throw new AiServiceError(
        'AI_UNAVAILABLE',
        'A IA retornou uma resposta inválida ao validar o modelo da guitarra.',
        503,
      );
    }

    if (!validated.data.recognized) {
      throw new AiServiceError(
        'INVALID_GUITAR_MODEL',
        validated.data.reason.trim() ||
          `O modelo "${guitarModel}" não foi reconhecido como uma guitarra válida. Informe marca/modelo ou configuração real (ex.: Fender Stratocaster HSS).`,
        422,
      );
    }

    const gear: AiGearConfig = {
      guitarModel,
      outputTarget,
      pickupSummary:
        validated.data.pickupSummary.trim() || 'Configuração padrão de captadores',
      recommendations: validated.data.recommendations
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 4),
      updatedAt: new Date().toISOString(),
    };

    this.writeAtomic(gear);
    return gear;
  }

  private writeAtomic(gear: AiGearConfig): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      fs.writeFileSync(tempPath, JSON.stringify(gear, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }
  }
}
