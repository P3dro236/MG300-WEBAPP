import {
  type AppErrorRecord,
  type ConnectMidiRequest,
  type ControllerState,
  type ExperimentalEditState,
  type ExperimentalSaveResult,
  MG300_EXPERIMENTAL_SLOT,
  type PairingChallengeInfo,
  type PairingDecisionPayload,
  type PairingPollPayload,
  type PairingRequestPayload,
  type PairingSessionInfo,
  type PairingStatusResponse,
  type PendingPairingRequest,
  type Preset,
  type PresetsDirectoryStatus,
  type PresetsResponse,
  type RemoveTrustedDevicePayload,
  type SelectPresetRequest,
  type SentCommandRecord,
  type TrustedDeviceInfo,
  type UpdateVolumeRequest,
  type WsClientMessage,
  type WsServerMessage,
} from '@quicktone/shared';

export type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

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
    connectionState: 'connecting',
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
    presetsDirectoryStatus: 'ok',
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

export interface ApiClientOptions {
  baseUrl?: string;
  /** Optional in-memory token for programmatic callers/tests; never persisted to localStorage. */
  token?: string;
}

export class QuickToneApiClient {
  private readonly baseUrl: string;
  private token: string;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.token = options.token?.trim() ?? '';
  }

  public setToken(token: string): void {
    this.token = token.trim();
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
      credentials: 'same-origin',
      headers,
    });

    let body: unknown = null;
    let isJsonObject = false;
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as unknown;
        body = parsed;
        isJsonObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      } catch {
        // Non-JSON responses (e.g., proxy HTML 502/504) must never leak raw text to UI error banners.
        body = null;
      }
    }

    if (!response.ok) {
      const record = (isJsonObject ? body : {}) as Record<string, unknown>;
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
        state: isJsonObject ? extractControllerState(body) : null,
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
      body: JSON.stringify({
        volume: request.volume,
        target: 'master_cc64',
      }),
    });
    return {
      state: extractControllerState(payload),
      command: extractSentCommand(payload),
    };
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

  // Pairing & Mobile Session API

  public async getPairingStatus(): Promise<PairingStatusResponse> {
    return this.request<PairingStatusResponse>('/api/pairing/status', {
      method: 'GET',
    });
  }

  public async createPairingChallenge(): Promise<{
    challenge: PairingChallengeInfo;
    activeSession: PairingSessionInfo | null;
    pendingRequests: PendingPairingRequest[];
    activeChallenge: PairingChallengeInfo | null;
    trustedDevices?: TrustedDeviceInfo[];
  }> {
    return this.request('/api/pairing/challenge', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  public async requestPairing(payload: PairingRequestPayload): Promise<{
    requestId: string;
    claimSecret: string;
    verificationCode: string;
    expiresAt: string;
  }> {
    return this.request('/api/pairing/request', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async pollPairing(payload: PairingPollPayload): Promise<
    | { status: 'pending'; verificationCode: string; expiresAt: string }
    | { status: 'rejected' }
    | { status: 'expired' }
    | { status: 'approved'; session: PairingSessionInfo }
    | { status: 'claimed'; session: PairingSessionInfo | null }
  > {
    return this.request('/api/pairing/poll', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async approvePairing(payload: PairingDecisionPayload): Promise<{
    activeSession: PairingSessionInfo;
    pendingRequests: PendingPairingRequest[];
    activeChallenge: PairingChallengeInfo | null;
    trustedDevices?: TrustedDeviceInfo[];
  }> {
    return this.request('/api/pairing/approve', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async rejectPairing(payload: PairingDecisionPayload): Promise<{
    ok: boolean;
    activeSession: PairingSessionInfo | null;
    pendingRequests: PendingPairingRequest[];
    activeChallenge: PairingChallengeInfo | null;
    trustedDevices?: TrustedDeviceInfo[];
  }> {
    return this.request('/api/pairing/reject', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async revokePairingSession(): Promise<{
    ok: boolean;
    activeSession: PairingSessionInfo | null;
    pendingRequests: PendingPairingRequest[];
    activeChallenge: PairingChallengeInfo | null;
    trustedDevices?: TrustedDeviceInfo[];
  }> {
    return this.request('/api/pairing/revoke', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  public async logoutPairingSession(): Promise<{ ok: boolean }> {
    return this.request('/api/pairing/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  public async loginTrustedDevice(): Promise<{
    ok: boolean;
    session: PairingSessionInfo;
  }> {
    return this.request('/api/pairing/trusted-login', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  public async removeTrustedDevice(payload: RemoveTrustedDevicePayload): Promise<{
    ok: boolean;
    activeSession: PairingSessionInfo | null;
    pendingRequests: PendingPairingRequest[];
    activeChallenge: PairingChallengeInfo | null;
    trustedDevices: TrustedDeviceInfo[];
  }> {
    return this.request('/api/pairing/trusted/remove', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // Experimental edit API

  /** Returns null when the backend does not expose the experimental routes (404). */
  public async getExperimentalState(): Promise<ExperimentalEditState | null> {
    try {
      const data = await this.request<ExperimentalEditState | null>('/api/experimental/state', {
        method: 'GET',
      });
      if (
        !data ||
        typeof data !== 'object' ||
        typeof data.loaded !== 'boolean' ||
        !Array.isArray(data.blocksEnabled)
      ) {
        return null;
      }
      return data;
    } catch (err) {
      if (err instanceof QuickToneApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  public loadExperimentalSlot(slot?: number): Promise<ExperimentalEditState> {
    return this.request('/api/experimental/load', {
      method: 'POST',
      body: JSON.stringify(slot !== undefined ? { slot } : {}),
    });
  }

  public createNewExperimentalPreset(payload?: {
    presetName?: string;
    bpm?: number;
    timeFlag?: number;
    targetSlot?: number;
  }): Promise<ExperimentalEditState> {
    return this.request('/api/experimental/new', {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    });
  }

  public importNuxPresetFile(payload: {
    fileName: string;
    contentBase64: string;
    bundleSlotIndex?: number;
  }): Promise<ExperimentalImportResponse> {
    return this.request('/api/experimental/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public setExperimentalMeta(payload: {
    presetName?: string;
    bpm?: number;
    timeFlag?: number;
  }): Promise<ExperimentalEditState> {
    return this.request('/api/experimental/meta', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  public setExperimentalAmpParam(index: number, value: number): Promise<ExperimentalEditState> {
    return this.request('/api/experimental/param', {
      method: 'PUT',
      body: JSON.stringify({ index, value }),
    });
  }

  public setExperimentalBlock(block: number, on: boolean): Promise<ExperimentalEditState> {
    return this.request('/api/experimental/block', {
      method: 'PUT',
      body: JSON.stringify({ block, on }),
    });
  }

  public setExperimentalBlockModel(
    block: number,
    modelId: number,
  ): Promise<ExperimentalEditState> {
    return this.request('/api/experimental/block-model', {
      method: 'PUT',
      body: JSON.stringify({ block, modelId }),
    });
  }

  public setExperimentalBlockParam(
    block: number,
    index: number,
    value: number,
  ): Promise<ExperimentalEditState> {
    return this.request('/api/experimental/block-param', {
      method: 'PUT',
      body: JSON.stringify({ block, index, value }),
    });
  }

  public setExperimentalLevel(
    target: 'patchVolume' | 'irVolume' | 'irCut' | 'cab' | 'mic',
    value: number,
  ): Promise<ExperimentalEditState> {
    return this.request('/api/experimental/level', {
      method: 'PUT',
      body: JSON.stringify({ target, value }),
    });
  }

  public saveExperimentalSlot(
    confirmSlot: number = MG300_EXPERIMENTAL_SLOT,
  ): Promise<ExperimentalSaveResult> {
    return this.request('/api/experimental/save', {
      method: 'POST',
      body: JSON.stringify({ confirmSlot }),
    });
  }

  public discardExperimentalEdit(): Promise<ExperimentalEditState> {
    return this.request('/api/experimental/discard', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }
}

export type { ExperimentalEditState, ExperimentalSaveResult };

export interface ExperimentalImportBundleSlot {
  index: number;
  slotIndex: number;
  displayBank: string;
  name: string;
  usesUserIr: boolean;
}

export interface ExperimentalImportResponse {
  state: ExperimentalEditState;
  importedCount: number;
  selectedIndex: number;
  bundleSlots?: ExperimentalImportBundleSlot[];
}

export interface WsManagerOptions {
  wsUrl?: string;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  onStatusChange: (status: WsConnectionStatus) => void;
  onMessage: (message: WsServerMessage) => void;
  onReconnected?: () => void;
  onAuthRevoked?: (reason: 'revoked' | 'expired') => void;
}

export function resolveDefaultWsUrl(): string {
  const loc = globalThis.window?.location;
  const protocol = loc?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = loc?.host || 'localhost:3001';
  return `${protocol}//${host}/ws`;
}

export class QuickToneWsManager {
  private readonly options: WsManagerOptions;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private disposed = false;
  private hadConnectedOnce = false;

  constructor(options: WsManagerOptions) {
    this.options = options;
  }

  public connect(): void {
    if (this.disposed) {
      return;
    }
    if (
      this.socket &&
      (this.socket.readyState === 0 || this.socket.readyState === 1)
    ) {
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

      ws.onclose = (event?: CloseEvent) => {
        if (this.disposed || this.socket !== ws) {
          return;
        }
        this.socket = null;
        if (event && (event.code === 4001 || event.code === 4002)) {
          this.disposed = true;
          this.clearReconnectTimer();
          this.options.onStatusChange('disconnected');
          this.options.onAuthRevoked?.(event.code === 4002 ? 'expired' : 'revoked');
          return;
        }
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

  public disconnect(silent = false): void {
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
    if (!silent) {
      this.options.onStatusChange('disconnected');
    }
  }

  private buildWsUrl(): string {
    if (this.options.wsUrl) {
      return this.options.wsUrl;
    }
    return resolveDefaultWsUrl();
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
