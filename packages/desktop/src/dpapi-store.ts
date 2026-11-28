import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import {
  type AuthSessionResponseV1,
  AuthSessionResponseV1Schema,
  type DeviceIdentityV1,
  DeviceIdentityV1Schema,
} from '@quicktone/shared';
import { writeFileAtomicSync } from './paths.js';

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface PersistedDpapiEnvelope {
  version: 1;
  cipher: 'dpapi';
  payloadBase64: string;
  updatedAt: string;
}

interface PersistedDeviceIdentityFile {
  deviceKeyId: string;
  createdAt: string;
}

function resolveSafeHostName(): string {
  const raw = os.hostname().trim().replace(/[^\w.-]+/g, ' ').trim();
  if (raw.length === 0) {
    return 'Windows Desktop';
  }
  return raw.slice(0, 80);
}

export class DpapiSessionStore {
  private readonly sessionFilePath: string;
  private readonly deviceIdentityPath: string;
  private readonly safeStorage: SafeStorageAdapter;
  private readonly logWarning: (message: string) => void;

  constructor(options: {
    sessionFilePath: string;
    deviceIdentityPath: string;
    safeStorage: SafeStorageAdapter;
    logWarning?: (message: string) => void;
  }) {
    this.sessionFilePath = options.sessionFilePath;
    this.deviceIdentityPath = options.deviceIdentityPath;
    this.safeStorage = options.safeStorage;
    this.logWarning = options.logWarning ?? (() => undefined);
  }

  isDpapiAvailable(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  getSession(): AuthSessionResponseV1 | null {
    if (!fs.existsSync(this.sessionFilePath)) {
      return null;
    }
    if (!this.isDpapiAvailable()) {
      this.logWarning('DPAPI indisponível ao tentar carregar sessão.');
      return null;
    }

    try {
      const raw = fs.readFileSync(this.sessionFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedDpapiEnvelope>;
      if (
        parsed.version !== 1 ||
        parsed.cipher !== 'dpapi' ||
        typeof parsed.payloadBase64 !== 'string' ||
        parsed.payloadBase64.length === 0
      ) {
        return null;
      }

      const encryptedBuffer = Buffer.from(parsed.payloadBase64, 'base64');
      const decryptedJson = this.safeStorage.decryptString(encryptedBuffer);
      const session = AuthSessionResponseV1Schema.safeParse(JSON.parse(decryptedJson));
      if (!session.success) {
        this.logWarning('Sessão DPAPI inválida ao validar schema.');
        return null;
      }
      return session.data;
    } catch (err) {
      this.logWarning(
        `Falha ao ler sessão DPAPI: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  setSession(input: AuthSessionResponseV1): AuthSessionResponseV1 {
    if (!this.isDpapiAvailable()) {
      throw new Error('Armazenamento protegido DPAPI indisponível neste dispositivo.');
    }

    const validated = AuthSessionResponseV1Schema.parse(input);
    const encryptedBuffer = this.safeStorage.encryptString(JSON.stringify(validated));
    const envelope: PersistedDpapiEnvelope = {
      version: 1,
      cipher: 'dpapi',
      payloadBase64: encryptedBuffer.toString('base64'),
      updatedAt: new Date().toISOString(),
    };
    writeFileAtomicSync(this.sessionFilePath, JSON.stringify(envelope, null, 2));
    return validated;
  }

  clearSession(): void {
    fs.rmSync(this.sessionFilePath, { force: true });
  }

  getOrCreateDeviceIdentity(): DeviceIdentityV1 {
    let deviceKeyId: string | null = null;

    if (fs.existsSync(this.deviceIdentityPath)) {
      try {
        const raw = fs.readFileSync(this.deviceIdentityPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedDeviceIdentityFile>;
        if (
          typeof parsed.deviceKeyId === 'string' &&
          parsed.deviceKeyId.length >= 16 &&
          parsed.deviceKeyId.length <= 128
        ) {
          deviceKeyId = parsed.deviceKeyId;
        }
      } catch {
        // Regenerate corrupt device identity metadata file
      }
    }

    if (!deviceKeyId) {
      deviceKeyId = crypto.randomBytes(32).toString('hex');
      const persisted: PersistedDeviceIdentityFile = {
        deviceKeyId,
        createdAt: new Date().toISOString(),
      };
      writeFileAtomicSync(this.deviceIdentityPath, JSON.stringify(persisted, null, 2));
    }

    return DeviceIdentityV1Schema.parse({
      deviceKeyId,
      deviceName: resolveSafeHostName(),
      platform: 'win32',
      dpapiAvailable: this.isDpapiAvailable(),
    });
  }
}
