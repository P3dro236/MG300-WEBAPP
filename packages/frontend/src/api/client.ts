import type {
  AppErrorRecord,
  ConfigurePresetsDirRequest,
  ConnectMidiRequest,
  ControllerState,
  Preset,
  PresetsDirectoryStatus,
  PresetsResponse,
  SelectPresetRequest,
  SentCommandRecord,
  UpdateVolumeRequest,
  WsClientMessage,
  WsServerMessage,
} from '@quicktone/shared';

export type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const TOKEN_STORAGE_KEY = 'quicktone_lan_token';

export class QuickToneApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly timestamp: string;
  public readonly state: ControllerState | null;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    timestamp?: string;
    state?: ControllerState | null;
  }) {
    super(options.message);
    this.name = 'QuickToneApiError';
    this.status = options.status;
    this.code = options.code;
    this.timestamp = options.timestamp ?? new Date().toISOString();
    this.state = options.state ?? null;
  }

  public toAppErrorRecord(): AppErrorRecord {
    return {
      code: this.code,
      message: this.message,
      timestamp: this.timestamp,
    };
  }
}

export function createInitialControllerState(): ControllerState {
  return {
    connectionState: 'disconnected',
    connectedPortName: null,
    availablePorts: [],
    syncStatus: 'unknown',
    confirmedState: {
      presetId: null,
      slotIndex: null,
      volume: null,
      volumeTarget: null,
      confirmedAt: null,
    },
    lastSentCommand: null,
    volumeTarget: 'master_cc64',
    presetsDirectory: null,
    presetsDirectoryStatus: 'unconfigured',
    includeFactoryPresets: true,
    presetCount: 0,
    warnings: [],
    authRequired: false,
    lastError: null,
  };
}

function isControllerStateLike(value: unknown): value is ControllerState {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.connectionState === 'string' &&
    typeof obj.syncStatus === 'string' &&
    typeof obj.confirmedState === 'object' &&
    obj.confirmedState !== null
  );
}

export function extractControllerState(payload: unknown): ControllerState | null {
  if (isControllerStateLike(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (isControllerStateLike(record.state)) {
      return record.state;
    }
  }
  return null;
}

function extractSentCommand(payload: unknown): SentCommandRecord | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.command && typeof record.command === 'object') {
    return record.command as SentCommandRecord;
  }
  if (record.lastSentCommand && typeof record.lastSentCommand === 'object') {
    return record.lastSentCommand as SentCommandRecord;
  }
  const state = extractControllerState(payload);
  return state?.lastSentCommand ?? null;
}

export function extractPresetsResponse(payload: unknown): PresetsResponse | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.presets)) {
    return {
      presets: record.presets as Preset[],
      directory: typeof record.directory === 'string' ? record.directory : null,
      directoryStatus:
        (record.directoryStatus as PresetsDirectoryStatus | undefined) ?? 'ok',
      warnings: Array.isArray(record.warnings) ? (record.warnings as string[]) : [],
    };
  }
  return null;
}

export function getStoredLanToken(): string {
  try {
    return globalThis.localStorage?.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredLanToken(token: string): void {
  try {
    if (token.trim()) {
      globalThis.localStorage?.setItem(TOKEN_STORAGE_KEY, token.trim());
    } else {
      globalThis.localStorage?.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota / private mode failures
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string;
}

export class QuickToneApiClient {
  private readonly baseUrl: string;
  private token: string;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.token = options.token ?? getStoredLanToken();
  }

  public setToken(token: string): void {
    this.token = token.trim();
    setStoredLanToken(this.token);
  }

  public getToken(): string {
    return this.token;
  }

  private buildHeaders(hasJsonBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (hasJsonBody) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.token) {
      headers['X-QuickTone-Token'] = this.token;
    }
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const hasBody = init.body !== undefined;
    const headers = {
      ...this.buildHeaders(hasBody),
      ...(init.headers as Record<string, string> | undefined),
    };

    const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { message: text };
      }
    }

    if (!response.ok) {
      const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      const nestedError =
        record.error && typeof record.error === 'object'
          ? (record.error as Record<string, unknown>)
          : null;

      const code =
        (typeof nestedError?.code === 'string' && nestedError.code) ||
        (typeof record.code === 'string' && record.code) ||
        (response.status === 401 ? 'AUTH_REQUIRED' : `HTTP_${response.status}`);

      const message =
        (typeof nestedError?.message === 'string' && nestedError.message) ||
        (typeof record.message === 'string' && record.message) ||
        (typeof record.error === 'string' && record.error) ||
        `Erro na comunicação com o servidor (HTTP ${response.status})`;

      const timestamp =
        (typeof nestedError?.timestamp === 'string' && nestedError.timestamp) ||
        new Date().toISOString();

      throw new QuickToneApiError({
        status: response.status,
        code,
        message,
        timestamp,
        state: extractControllerState(body),
      });
    }

    return body as T;
  }

  public async getState(): Promise<ControllerState> {
    const payload = await this.request<unknown>('/api/status', { method: 'GET' });
    return extractControllerState(payload) ?? createInitialControllerState();
  }

  public async getPresets(): Promise<PresetsResponse> {
    const payload = await this.request<unknown>('/api/presets', { method: 'GET' });
    return (
      extractPresetsResponse(payload) ?? {
        presets: [],
        directory: null,
        directoryStatus: 'unconfigured',
        warnings: [],
      }
    );
  }

  public async selectPreset(request: SelectPresetRequest): Promise<{
    state: ControllerState | null;
    command: SentCommandRecord | null;
  }> {
    const payload = await this.request<unknown>('/api/presets/select', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return {
      state: extractControllerState(payload),
      command: extractSentCommand(payload),
    };
  }

  public async updateVolume(request: UpdateVolumeRequest): Promise<{
    state: ControllerState | null;
    command: SentCommandRecord | null;
  }> {
    const payload = await this.request<unknown>('/api/volume', {
      method: 'PUT',
      body: JSON.stringify(request),
    });
    return {
      state: extractControllerState(payload),
      command: extractSentCommand(payload),
    };
  }

  public async setVolumeTarget(
    target: NonNullable<UpdateVolumeRequest['target']>,
  ): Promise<ControllerState | null> {
    const payload = await this.request<unknown>('/api/volume/target', {
      method: 'POST',
      body: JSON.stringify({ target }),
    });
    return extractControllerState(payload);
  }

  public async connectMidi(request: ConnectMidiRequest = {}): Promise<ControllerState | null> {
    const payload = await this.request<unknown>('/api/midi/connect', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return extractControllerState(payload);
  }

  public async disconnectMidi(): Promise<ControllerState | null> {
    const payload = await this.request<unknown>('/api/midi/disconnect', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return extractControllerState(payload);
  }

  public async configurePresetsDirectory(request: ConfigurePresetsDirRequest): Promise<{
    state: ControllerState | null;
    presetsResponse: PresetsResponse | null;
  }> {
    const payload = await this.request<unknown>('/api/presets/config', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return {
      state: extractControllerState(payload),
      presetsResponse: extractPresetsResponse(payload),
    };
  }

  public async reloadPresets(): Promise<{
    state: ControllerState | null;
    presetsResponse: PresetsResponse | null;
  }> {
    const payload = await this.request<unknown>('/api/presets/reload', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return {
      state: extractControllerState(payload),
      presetsResponse: extractPresetsResponse(payload),
    };
  }
}

export interface WsManagerOptions {
  wsUrl?: string;
  token?: string;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  onStatusChange: (status: WsConnectionStatus) => void;
  onMessage: (message: WsServerMessage) => void;
  onReconnected?: () => void;
}

export function resolveDefaultWsUrl(token?: string): string {
  const loc = globalThis.window?.location;
  const protocol = loc?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = loc?.host || 'localhost:3001';
  const base = `${protocol}//${host}/ws`;
  if (token && token.trim()) {
    return `${base}?token=${encodeURIComponent(token.trim())}`;
  }
  return base;
}

export class QuickToneWsManager {
  private readonly options: WsManagerOptions;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private disposed = false;
  private hadConnectedOnce = false;
  private token: string;

  constructor(options: WsManagerOptions) {
    this.options = options;
    this.token = options.token ?? getStoredLanToken();
  }

  public setToken(token: string): void {
    this.token = token.trim();
  }

  public connect(): void {
    if (this.disposed) {
      return;
    }
    this.clearReconnectTimer();

    const WsConstructor = globalThis.WebSocket;
    if (!WsConstructor) {
      this.options.onStatusChange('disconnected');
      return;
    }

    const isRetry = this.reconnectAttempts > 0 || this.hadConnectedOnce;
    this.options.onStatusChange(isRetry ? 'reconnecting' : 'connecting');

    const url = this.buildWsUrl();
    try {
      const ws = new WsConstructor(url);
      this.socket = ws;

      ws.onopen = () => {
        if (this.disposed || this.socket !== ws) {
          return;
        }
        const wasReconnecting = this.reconnectAttempts > 0 || this.hadConnectedOnce;
        this.reconnectAttempts = 0;
        this.hadConnectedOnce = true;
        this.options.onStatusChange('connected');
        if (wasReconnecting) {
          this.send({ type: 'request_sync' });
          this.options.onReconnected?.();
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.disposed || this.socket !== ws) {
          return;
        }
        try {
          const parsed = JSON.parse(String(event.data)) as WsServerMessage;
          if (parsed && typeof parsed === 'object' && 'type' in parsed) {
            this.options.onMessage(parsed);
          }
        } catch {
          // Ignore malformed WS frames
        }
      };

      ws.onerror = () => {
        // Browser fires onclose right after onerror; ensure reconnect is scheduled if socket already closed
      };

      ws.onclose = () => {
        if (this.disposed || this.socket !== ws) {
          return;
        }
        this.socket = null;
        this.scheduleReconnect();
      };
    } catch {
      this.socket = null;
      this.scheduleReconnect();
    }
  }

  public send(message: WsClientMessage): void {
    if (this.socket && this.socket.readyState === 1) {
      try {
        this.socket.send(JSON.stringify(message));
      } catch {
        // Ignore send errors on closing socket
      }
    }
  }

  public disconnect(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    if (this.socket) {
      const ws = this.socket;
      this.socket = null;
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch {
        // Ignore close errors
      }
    }
    this.options.onStatusChange('disconnected');
  }

  private buildWsUrl(): string {
    if (this.options.wsUrl) {
      if (this.token && !this.options.wsUrl.includes('token=')) {
        const sep = this.options.wsUrl.includes('?') ? '&' : '?';
        return `${this.options.wsUrl}${sep}token=${encodeURIComponent(this.token)}`;
      }
      return this.options.wsUrl;
    }
    return resolveDefaultWsUrl(this.token);
  }

  private scheduleReconnect(): void {
    if (this.disposed) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectAttempts += 1;
    this.options.onStatusChange('reconnecting');

    const baseDelay = this.options.reconnectBaseDelayMs ?? 1000;
    const maxDelay = this.options.reconnectMaxDelayMs ?? 8000;
    const delay = Math.min(maxDelay, baseDelay * Math.pow(1.5, this.reconnectAttempts - 1));

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
