import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ControllerState,
  PairingStatusResponse,
  Preset,
  PresetsResponse,
  WsServerMessage,
} from '@quicktone/shared';
import { App } from '../App.js';
import {
  APP_STORAGE_KEY,
  loadPersistedAppData,
  mergePresetsSafely,
} from '../utils/storage.js';

const MOCK_PRESETS: Preset[] = [
  {
    id: '1A',
    slotIndex: 0,
    bankType: 'user',
    bankNumber: 1,
    patchLetter: 'A',
    displayBank: '1A',
    name: 'EaglesDF Crunch',
    patchVolume: 50,
    irVolume: 30,
    origin: 'hardware',
    isDuplicate: false,
    updatedAt: '2026-11-23T20:00:00.000Z',
    midiMapping: {
      protocol: 'mg300-cc60',
      channel: 0,
      ccNumber: 60,
      ccValue: 0,
    },
  },
  {
    id: '1B',
    slotIndex: 1,
    bankType: 'user',
    bankNumber: 1,
    patchLetter: 'B',
    displayBank: '1B',
    name: 'SCORPIONS',
    patchVolume: 64,
    irVolume: 35,
    origin: 'hardware',
    isDuplicate: false,
    updatedAt: '2026-11-23T20:00:00.000Z',
    midiMapping: {
      protocol: 'mg300-cc60',
      channel: 0,
      ccNumber: 60,
      ccValue: 1,
    },
  },
  {
    id: '5A',
    slotIndex: 16,
    bankType: 'user',
    bankNumber: 5,
    patchLetter: 'A',
    displayBank: '5A',
    name: 'RG J. Mayer',
    patchVolume: 50,
    origin: 'hardware',
    isDuplicate: false,
    updatedAt: '2026-11-23T20:00:00.000Z',
    midiMapping: {
      protocol: 'mg300-cc60',
      channel: 0,
      ccNumber: 60,
      ccValue: 16,
    },
  },
  {
    id: '6A',
    slotIndex: 20,
    bankType: 'user',
    bankNumber: 6,
    patchLetter: 'A',
    displayBank: '6A',
    name: 'User 6A',
    patchVolume: 50,
    origin: 'placeholder',
    isDuplicate: false,
    updatedAt: '2026-11-23T20:00:00.000Z',
    midiMapping: {
      protocol: 'mg300-cc60',
      channel: 0,
      ccNumber: 60,
      ccValue: 20,
    },
  },
  {
    id: 'F1A',
    slotIndex: 36,
    bankType: 'factory',
    bankNumber: 1,
    patchLetter: 'A',
    displayBank: 'F1A',
    name: 'CT 80JM Drive',
    patchVolume: 50,
    origin: 'factory',
    isDuplicate: false,
    updatedAt: '2026-11-23T20:00:00.000Z',
    midiMapping: {
      protocol: 'mg300-cc60',
      channel: 0,
      ccNumber: 60,
      ccValue: 36,
    },
  },
  {
    id: 'F5A',
    slotIndex: 52,
    bankType: 'factory',
    bankNumber: 5,
    patchLetter: 'A',
    displayBank: 'F5A',
    name: 'RG J. Mayer',
    patchVolume: 50,
    origin: 'factory',
    isDuplicate: false,
    updatedAt: '2026-11-23T20:00:00.000Z',
    midiMapping: {
      protocol: 'mg300-cc60',
      channel: 0,
      ccNumber: 60,
      ccValue: 52,
    },
  },
];

function buildMockState(overrides: Partial<ControllerState> = {}): ControllerState {
  return {
    connectionState: 'connected',
    connectedPortName: 'NUX NME-300',
    availablePorts: [
      {
        id: 'port-mg300',
        name: 'NUX NME-300',
        direction: 'duplex',
        isMg300: true,
      },
    ],
    syncStatus: 'confirmed',
    confirmedState: {
      presetId: '1A',
      slotIndex: 0,
      volume: 50,
      volumeTarget: 'master_cc64',
      confirmedAt: '2026-11-23T20:00:00.000Z',
    },
    lastSentCommand: null,
    volumeTarget: 'master_cc64',
    presetsDirectory: null,
    presetsDirectoryStatus: 'ok',
    presetCount: MOCK_PRESETS.length,
    warnings: [],
    authRequired: false,
    lastError: null,
    ...overrides,
  };
}

function buildPresetsResponse(
  overrides: Partial<PresetsResponse> = {},
): PresetsResponse {
  return {
    presets: MOCK_PRESETS,
    directory: null,
    directoryStatus: 'ok',
    warnings: [],
    ...overrides,
  };
}

class MockWebSocket {
  public static instances: MockWebSocket[] = [];
  public readonly url: string;
  public readyState = 0; // CONNECTING
  public sentMessages: string[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: ((event?: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  public send(data: string): void {
    this.sentMessages.push(data);
  }

  public close(): void {
    this.readyState = 3; // CLOSED
  }

  public triggerOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  public triggerMessage(message: WsServerMessage): void {
    const event = { data: JSON.stringify(message) } as MessageEvent;
    this.onmessage?.(event);
  }

  public triggerClose(code = 1006): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code } as CloseEvent);
  }
}

interface FetchCallRecord {
  url: string;
  method: string;
  body: unknown;
}

describe('@quicktone/frontend — Testes Unitários da Interface', () => {
  let currentState: ControllerState;
  let currentPresetsResponse: PresetsResponse;
  let currentPairingStatus: PairingStatusResponse;
  let fetchCalls: FetchCallRecord[];
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    localStorage.clear();
    MockWebSocket.instances = [];
    fetchCalls = [];
    currentState = buildMockState();
    currentPresetsResponse = buildPresetsResponse();
    currentPairingStatus = {
      isLocalDesktop: true,
      authenticated: true,
      sessionStatus: 'desktop',
      activeSession: null,
      pendingRequests: [],
      activeChallenge: null,
      lanUrls: ['http://192.168.1.50:3001'],
    };

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const parsedBody =
        typeof init?.body === 'string' && init.body.length > 0
          ? (JSON.parse(init.body) as unknown)
          : null;

      fetchCalls.push({ url, method, body: parsedBody });

      if (url.endsWith('/api/pairing/status') && method === 'GET') {
        return new Response(JSON.stringify(currentPairingStatus), { status: 200 });
      }

      if ((url.endsWith('/api/status') || url.endsWith('/api/state')) && method === 'GET') {
        return new Response(JSON.stringify(currentState), { status: 200 });
      }

      if (url.endsWith('/api/presets') && method === 'GET') {
        return new Response(JSON.stringify(currentPresetsResponse), { status: 200 });
      }

      if (url.endsWith('/api/presets/select') && method === 'POST') {
        const body = parsedBody as { presetId?: string; slotIndex?: number };
        const command = {
          commandId: 'cmd-select-1',
          type: 'preset_select' as const,
          presetId: body.presetId ?? '1B',
          slotIndex: body.slotIndex ?? 1,
          midiBytes: [0xb0, 0x3c, body.slotIndex ?? 1],
          sentAt: '2026-11-23T20:01:00.000Z',
          confirmedByDevice: false,
        };
        currentState = {
          ...currentState,
          syncStatus: 'command_sent_unconfirmed',
          lastSentCommand: command,
        };
        return new Response(
          JSON.stringify({ state: currentState, command }),
          { status: 200 },
        );
      }

      if (url.endsWith('/api/volume') && method === 'PUT') {
        const body = parsedBody as { volume: number; target?: ControllerState['volumeTarget'] };
        const command = {
          commandId: 'cmd-vol-1',
          type: 'volume_change' as const,
          volume: body.volume,
          volumeTarget: 'master_cc64' as const,
          midiBytes: [0xb0, 0x40, body.volume],
          sentAt: '2026-11-23T20:02:00.000Z',
          confirmedByDevice: false,
        };
        currentState = {
          ...currentState,
          syncStatus: 'command_sent_unconfirmed',
          lastSentCommand: command,
        };
        return new Response(
          JSON.stringify({ state: currentState, command }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it('1. Biblioteca com 2 filtros (Usuário / Fábrica), oculta placeholders e remove Patch Level, Expression, seletor de Fader e hex', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1A')).toBeInTheDocument();
    });

    // Apenas 2 abas de filtro: Usuário e Fábrica (sem "Todos")
    expect(screen.queryByTestId('filter-tab-all')).not.toBeInTheDocument();
    expect(screen.getByTestId('filter-tab-user')).toHaveTextContent('Usuário (2)');
    expect(screen.getByTestId('filter-tab-factory')).toHaveTextContent('Fábrica (2)');

    // Placeholders (6A) e cópias de fábrica não modificadas (5A) são ocultadas da aba Usuário
    expect(screen.queryByTestId('preset-card-6A')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preset-card-5A')).not.toBeInTheDocument();

    // Sem seletor de Fader, Patch Level, Expression ou strings hex
    expect(screen.queryByTestId('volume-target-quick-patch_cc74')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('volume-target-quick-expression_cc61'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/P\.LVL/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/CC\s*64|CC\s*74|CC\s*61/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/OLED CHASSIS/i)).not.toBeInTheDocument();

    // Filtra apenas presets de Fábrica (F1A, F5A)
    fireEvent.click(screen.getByTestId('filter-tab-factory'));
    expect(screen.queryByTestId('preset-card-1A')).not.toBeInTheDocument();
    expect(screen.getByTestId('preset-card-F1A')).toBeInTheDocument();
    expect(screen.getByTestId('preset-card-F5A')).toBeInTheDocument();

    // Volta para Usuário (1A, 1B)
    fireEvent.click(screen.getByTestId('filter-tab-user'));
    expect(screen.getByTestId('preset-card-1A')).toBeInTheDocument();
    expect(screen.getByTestId('preset-card-1B')).toBeInTheDocument();
    expect(screen.queryByTestId('preset-card-F1A')).not.toBeInTheDocument();
  });

  it('2. Seleção de preset: clique dispara POST /api/presets/select, exibe "Enviando…" e atualiza para "Ativo"', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1A')).toHaveAttribute(
        'data-status',
        'confirmed',
      );
    });

    fireEvent.click(screen.getByTestId('preset-card-1B'));

    await waitFor(() => {
      const selectCall = fetchCalls.find(
        (c) => c.url.endsWith('/api/presets/select') && c.method === 'POST',
      );
      expect(selectCall?.body).toEqual({ presetId: '1B', slotIndex: 1 });
    });

    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1B')).toHaveAttribute(
        'data-status',
        'command_sent_unconfirmed',
      );
    });

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'state_sync',
        timestamp: '2026-11-23T20:01:05.000Z',
        state: buildMockState({
          syncStatus: 'confirmed',
          confirmedState: {
            presetId: '1B',
            slotIndex: 1,
            volume: 64,
            volumeTarget: 'master_cc64',
            confirmedAt: '2026-11-23T20:01:05.000Z',
          },
          lastSentCommand: {
            commandId: 'cmd-select-1',
            type: 'preset_select',
            presetId: '1B',
            slotIndex: 1,
            midiBytes: [0xb0, 0x3c, 1],
            sentAt: '2026-11-23T20:01:00.000Z',
            confirmedByDevice: true,
          },
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1B')).toHaveAttribute(
        'data-status',
        'confirmed',
      );
    });
  });

  it('3. Master Volume: envia PUT /api/volume exclusivo para master_cc64 e ignora ecos intermediários durante interação', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('volume-slider')).toBeInTheDocument();
    });

    const slider = screen.getByLabelText('Volume Master');
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '78' } });

    await waitFor(() => {
      const volCall = fetchCalls.find(
        (c) => c.url.endsWith('/api/volume') && c.method === 'PUT',
      );
      expect(volCall?.body).toEqual({
        volume: 78,
        target: 'master_cc64',
      });
    });

    // Um broadcast WS antigo com 50% NÃO pode fazer o slider voltar/piscar durante o ajuste
    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'state_sync',
        timestamp: '2026-11-23T20:02:01.000Z',
        state: buildMockState({
          confirmedState: {
            presetId: '1A',
            slotIndex: 0,
            volume: 50,
            volumeTarget: 'master_cc64',
            confirmedAt: '2026-11-23T20:02:01.000Z',
          },
        }),
      });
    });

    expect(screen.getByTestId('volume-value')).toHaveTextContent('78%');
    fireEvent.pointerUp(slider);
  });

  it('4. Estado de conexão e Tri-State: separa conexão MIDI da conexão WebSocket sem mascarar falhas', async () => {
    currentState = buildMockState({
      connectionState: 'disconnected',
      connectedPortName: null,
      syncStatus: 'unknown',
      confirmedState: {
        presetId: null,
        slotIndex: null,
        volume: null,
        volumeTarget: null,
        confirmedAt: null,
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('midi-connection-badge')).toHaveAttribute(
        'data-connection-state',
        'disconnected',
      );
    });

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.triggerOpen();
    });
    // WS está online mesmo com MIDI desconectado
    expect(screen.getByTestId('ws-connection-badge')).toHaveAttribute(
      'data-ws-status',
      'connected',
    );
    expect(screen.getByTestId('midi-connection-badge')).toHaveTextContent(
      'Pedaleira desconectada',
    );
  });

  it('5. Reconexão WebSocket: simula queda da conexão WS, exibe estado de reconexão e ressincroniza automaticamente', async () => {
    render(<App reconnectBaseDelayMs={25} />);

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    const firstWs = MockWebSocket.instances[0]!;
    act(() => {
      firstWs.triggerOpen();
    });

    await waitFor(() => {
      expect(screen.getByTestId('ws-connection-badge')).toHaveAttribute(
        'data-ws-status',
        'connected',
      );
    });

    currentState = buildMockState({
      syncStatus: 'confirmed',
      confirmedState: {
        presetId: 'F1A',
        slotIndex: 36,
        volume: 85,
        volumeTarget: 'master_cc64',
        confirmedAt: '2026-11-23T20:04:00.000Z',
      },
    });

    act(() => {
      firstWs.triggerClose();
    });

    await waitFor(() => {
      expect(screen.getByTestId('ws-connection-badge')).toHaveAttribute(
        'data-ws-status',
        'reconnecting',
      );
    });

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    });

    const secondWs = MockWebSocket.instances[1]!;
    act(() => {
      secondWs.triggerOpen();
    });

    await waitFor(() => {
      expect(screen.getByTestId('ws-connection-badge')).toHaveAttribute(
        'data-ws-status',
        'connected',
      );
      expect(screen.getByTestId('stage-display')).toHaveTextContent('F1A');
      expect(screen.queryByTestId('open-tone-editor-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('volume-value')).toHaveTextContent('85%');
    });
  });

  it('6. localStorage: persiste presets e preferências, recupera de corrupção e não sobrescreve com resposta vazia', async () => {
    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1A')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('filter-tab-factory'));
    expect(loadPersistedAppData().preferences.filter).toBe('factory');
    expect(loadPersistedAppData().presets.length).toBeGreaterThanOrEqual(4);

    // Simula resposta vazia do servidor: não deve apagar presets salvos no localStorage
    currentPresetsResponse = buildPresetsResponse({ presets: [] });
    unmount();

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('preset-card-F1A')).toBeInTheDocument();
    });
    expect(screen.getByTestId('filter-tab-factory')).toHaveClass('font-semibold');

    // Simula dado corrompido no localStorage: não deve quebrar a aplicação
    cleanup();
    localStorage.setItem(APP_STORAGE_KEY, '{corrupted_json');
    expect(loadPersistedAppData().presets).toEqual([]);

    const merged = mergePresetsSafely(MOCK_PRESETS, []);
    expect(merged.length).toBeGreaterThan(0);
  });

  it('7. Pareamento QR Code: bloqueia celular não autorizado e exibe solicitação pendente no desktop', async () => {
    currentPairingStatus = {
      isLocalDesktop: false,
      authenticated: false,
      sessionStatus: 'none',
      activeSession: null,
      pendingRequests: [],
      activeChallenge: null,
      lanUrls: [],
    };

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('mobile-pairing-gate')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('preset-grid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('volume-control-panel')).not.toBeInTheDocument();

    cleanup();

    // No desktop com solicitação pendente, exibe banner de autorização
    currentPairingStatus = {
      isLocalDesktop: true,
      authenticated: true,
      sessionStatus: 'desktop',
      activeSession: null,
      pendingRequests: [
        {
          requestId: 'req-1',
          deviceName: 'iPhone Pedro',
          remoteIp: '192.168.1.50',
          verificationCode: '482910',
          createdAt: '2026-11-25T00:00:00.000Z',
          expiresAt: '2026-11-25T00:02:00.000Z',
        },
      ],
      activeChallenge: null,
      lanUrls: ['http://192.168.1.10:3001'],
    };

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('desktop-pairing-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('desktop-pairing-banner')).toHaveTextContent('482910');
    expect(screen.getByTestId('approve-pairing-btn')).toBeInTheDocument();
  });

  it('8. Exibição de erros: oculta prefixos técnicos e valores hexadecimais no ErrorBanner', async () => {
    currentState = buildMockState({
      connectionState: 'error',
      connectedPortName: null,
      lastError: {
        code: 'PORT_BUSY',
        message: 'A porta USB-MIDI NUX NME-300 (0x40) está ocupada por outro processo.',
        timestamp: '2026-11-23T20:05:00.000Z',
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('error-banner')).toBeInTheDocument();
    });

    const alertBanner = screen.getByTestId('error-banner');
    expect(alertBanner).toHaveAttribute('data-error-code', 'PORT_BUSY');
    expect(alertBanner).not.toHaveTextContent('[PORT_BUSY]');
    expect(alertBanner).not.toHaveTextContent('0x40');
    expect(screen.queryByTestId('directory-error-banner')).not.toBeInTheDocument();
  });

  it('9. Pareamento via QR Code (?pair=...) funciona sob React <StrictMode> sem consumir o código duas vezes', async () => {
    window.history.pushState({}, '', '/?pair=StrictQrCode99');
    currentPairingStatus = {
      isLocalDesktop: false,
      authenticated: false,
      sessionStatus: 'none',
      activeSession: null,
      pendingRequests: [],
      activeChallenge: null,
      lanUrls: [],
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/pairing/request')) {
        fetchCalls.push({
          url,
          method: (init?.method ?? 'POST').toUpperCase(),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        return new Response(
          JSON.stringify({
            requestId: 'req-strict-1',
            claimSecret: 'secret-strict-1',
            verificationCode: '654321',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/pairing/poll')) {
        currentPairingStatus = {
          ...currentPairingStatus,
          authenticated: true,
          sessionStatus: 'active',
        };
        return new Response(
          JSON.stringify({
            status: 'approved',
            session: {
              sessionId: 'sess-1',
              deviceName: 'Celular',
              remoteIp: '192.168.1.50',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              lastActivityAt: new Date().toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('mobile-verification-code')).toHaveTextContent('654321');
    });

    const pairRequests = fetchCalls.filter((c) => c.url.endsWith('/api/pairing/request'));
    expect(pairRequests).toHaveLength(1);
    expect(window.location.search).toBe('');

    // Polling aprova e libera o controlador completo
    await waitFor(
      () => {
        expect(screen.getByTestId('preset-grid')).toBeInTheDocument();
      },
      { timeout: 2500 },
    );
  });

  it('10. Dispositivos Confiáveis: lista e remove no desktop, e reconecta automaticamente no celular confiável', async () => {
    currentPairingStatus = {
      isLocalDesktop: true,
      authenticated: true,
      sessionStatus: 'desktop',
      activeSession: null,
      pendingRequests: [],
      activeChallenge: null,
      lanUrls: ['http://192.168.1.50:3001'],
      trustedDevices: [
        {
          deviceId: 'dev-1',
          deviceName: 'Galaxy S25 Pedro',
          remoteIp: '192.168.1.88',
          createdAt: '2026-11-25T03:00:00.000Z',
          lastConnectedAt: '2026-11-25T03:10:00.000Z',
          isCurrentlyActive: true,
        },
      ],
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/pairing/trusted/remove')) {
        fetchCalls.push({
          url,
          method: (init?.method ?? 'POST').toUpperCase(),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        currentPairingStatus = {
          ...currentPairingStatus,
          trustedDevices: [],
        };
        return new Response(
          JSON.stringify({
            ok: true,
            activeSession: null,
            pendingRequests: [],
            activeChallenge: null,
            trustedDevices: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/pairing/trusted-login')) {
        fetchCalls.push({
          url,
          method: 'POST',
          body: {},
        });
        currentPairingStatus = {
          ...currentPairingStatus,
          authenticated: true,
          sessionStatus: 'active',
        };
        return new Response(JSON.stringify({ ok: true, session: null }), { status: 200 });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('open-settings-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-settings-btn'));
    expect(screen.getByTestId('trusted-devices-section')).toHaveTextContent(
      'Galaxy S25 Pedro',
    );

    fireEvent.click(screen.getByTestId('remove-trusted-device-btn-dev-1'));
    await waitFor(() => {
      expect(screen.queryByTestId('trusted-device-row-dev-1')).not.toBeInTheDocument();
    });

    cleanup();

    // Mobile trusted device auto-reconnects without QR Code
    currentPairingStatus = {
      isLocalDesktop: false,
      authenticated: false,
      sessionStatus: 'none',
      activeSession: null,
      pendingRequests: [],
      activeChallenge: null,
      lanUrls: [],
      isTrustedDevice: true,
      trustedDeviceName: 'Galaxy S25 Pedro',
    };

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('preset-grid')).toBeInTheDocument();
    });
    expect(
      fetchCalls.some((c) => c.url.endsWith('/api/pairing/trusted-login')),
    ).toBe(true);
  });

  it('11. Editor 10-Blocos ao Vivo: carrega slot 4D, troca modelos dinâmicos, cria/importa presets e grava em slots 1A–9D', async () => {
    let expState = {
      slot: 15,
      loaded: false,
      busy: false,
      dirty: false,
      sourceMode: 'hardware' as 'hardware' | 'draft' | 'imported',
      sourceFileName: null as string | null,
      presetName: null as string | null,
      bpm: 120,
      timeFlag: 0,
      ampParams: [] as number[],
      blocksEnabled: [] as boolean[],
      blockModels: {} as Record<string, number>,
      blockParams: {} as Record<string, number[]>,
      cabEnabled: false,
      cabModel: 0,
      micModel: 0,
      irCut: 0,
      irVolume: 20,
      patchVolume: 50,
      hasUserIr: false,
      userIrName: null as string | null,
      userIrWarning: null as string | null,
      lastSave: null as null | {
        targetSlot: number;
        displayBank: string;
        ackReceived: boolean;
        verified: boolean;
        mismatchedOffsets: number[];
        backupPath: string;
        savedAt: string;
      },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body =
        typeof init?.body === 'string' && init.body.length > 0
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};

      if (url.endsWith('/api/experimental/state')) {
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/load')) {
        expState = {
          ...expState,
          loaded: true,
          dirty: false,
          sourceMode: 'hardware',
          presetName: 'EmotiveBallad',
          bpm: 120,
          ampParams: [45, 50, 55, 60, 65, 50],
          blocksEnabled: [true, true, true, true, true, false, true, true],
          blockModels: {
            '1': 1,
            '2': 1,
            '3': 1,
            '4': 1,
            '5': 1,
            '6': 0,
            '7': 2,
            '8': 1,
            '9': 5,
            '10': 2,
          },
          blockParams: {
            '1': [40, 50, 0, 0, 0, 0],
            '2': [50, 50, 0, 0, 0, 0],
            '3': [45, 0, 50, 55, 60, 65],
            '4': [50, 50, 50, 50, 50, 50],
            '7': [35, 40, 30, 0, 0, 0],
          },
          cabEnabled: true,
          cabModel: 5,
          micModel: 2,
          patchVolume: 65,
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/block-model')) {
        fetchCalls.push({ url, method, body });
        const b = String(body.block);
        const modelId = Number(body.modelId);
        expState = {
          ...expState,
          dirty: true,
          blockModels: { ...expState.blockModels, [b]: modelId },
          cabEnabled: b === '9' ? modelId > 0 : expState.cabEnabled,
          cabModel: b === '9' ? modelId : expState.cabModel,
          micModel: b === '10' ? modelId : expState.micModel,
          hasUserIr: b === '9' ? modelId === 100 : expState.hasUserIr,
          userIrWarning:
            b === '9' && modelId === 100
              ? 'Este preset utiliza um User IR customizado.'
              : expState.userIrWarning,
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/block-param')) {
        fetchCalls.push({ url, method, body });
        const b = String(body.block);
        const idx = Number(body.index);
        const val = Number(body.value);
        const arr = [...(expState.blockParams[b] ?? [0, 0, 0, 0, 0, 0])];
        arr[idx] = val;
        expState = { ...expState, dirty: true, blockParams: { ...expState.blockParams, [b]: arr } };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/block')) {
        fetchCalls.push({ url, method, body });
        const b = String(body.block);
        const bIdx = Number(body.block) - 1;
        const nextBlocks = [...expState.blocksEnabled];
        nextBlocks[bIdx] = Boolean(body.on);
        expState = {
          ...expState,
          blocksEnabled: nextBlocks,
          blockModels: { ...expState.blockModels, [b]: body.on ? 1 : 0 },
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/level')) {
        fetchCalls.push({ url, method, body });
        expState = { ...expState, patchVolume: Number(body.value) };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/new')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          loaded: true,
          dirty: true,
          sourceMode: 'draft',
          sourceFileName: null,
          presetName: 'New Preset',
          bpm: 120,
          blockModels: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 1, '6': 0, '7': 0, '8': 0, '9': 1, '10': 2 },
          blockParams: { '3': [50, 0, 50, 50, 50, 50] },
          cabEnabled: true,
          cabModel: 1,
          micModel: 2,
          hasUserIr: false,
          userIrWarning: null,
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/meta')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          dirty: true,
          presetName: typeof body.presetName === 'string' ? body.presetName : expState.presetName,
          bpm: typeof body.bpm === 'number' ? body.bpm : expState.bpm,
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/import')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          loaded: true,
          dirty: true,
          sourceMode: 'imported',
          sourceFileName: String(body.fileName),
          presetName: 'Shin on Crazy',
          cabEnabled: true,
          cabModel: 100,
          hasUserIr: true,
          userIrName: 'CustomV30',
          userIrWarning:
            'Este preset utiliza o User IR "CustomV30". Os blocos e parâmetros serão gravados normalmente.',
        };
        return new Response(
          JSON.stringify({ state: expState, importedCount: 1, selectedIndex: 0 }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/experimental/save')) {
        fetchCalls.push({ url, method, body });
        const slot = Number(body.confirmSlot);
        const saveResult = {
          targetSlot: slot,
          displayBank: '5A',
          ackReceived: true,
          verified: true,
          mismatchedOffsets: [],
          backupPath: `slot-${slot}.json`,
          savedAt: new Date().toISOString(),
        };
        expState = {
          ...expState,
          slot,
          dirty: false,
          sourceMode: 'hardware',
          lastSave: saveResult,
        };
        return new Response(JSON.stringify(saveResult), { status: 200 });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    render(<App />);

    // Tela principal limpa: editor NÃO aparece montado no boot inicial
    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1A')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('experimental-edit-panel')).not.toBeInTheDocument();

    // Seleciona slot 1A para ativar "Editar timbre"
    fireEvent.click(screen.getByTestId('preset-card-1A'));
    await waitFor(() => {
      expect(screen.getByTestId('open-tone-editor-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-tone-editor-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-select-block-EQ')).toBeInTheDocument();
      expect(screen.getByTestId('exp-select-block-CAB')).toBeInTheDocument();
      expect(screen.getByTestId('exp-select-block-MIC')).toBeInTheDocument();
    });

    // Seleciona EFX e troca modelo de Dist+ -> T Screamer -> rótulos mudam dinamicamente para Level/Tone/Drive
    fireEvent.click(screen.getByTestId('exp-select-block-EFX'));
    expect(screen.getByText('Distortion')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('exp-model-select-EFX'), { target: { value: '5' } });
    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        url: '/api/experimental/block-model',
        method: 'PUT',
        body: { block: 2, modelId: 5 },
      });
      expect(screen.getByText('Drive')).toBeInTheDocument();
    });

    // Seleciona EQ e move banda 2 (500Hz -> index 2)
    fireEvent.click(screen.getByTestId('exp-select-block-EQ'));
    fireEvent.change(screen.getByTestId('exp-slider-EQ-2'), { target: { value: '74' } });

    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        url: '/api/experimental/block-param',
        method: 'PUT',
        body: { block: 4, index: 2, value: 74 },
      });
    });

    // Alterna estado do bloco EQ
    fireEvent.click(screen.getByTestId('exp-toggle-block-EQ'));
    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        url: '/api/experimental/block',
        method: 'PUT',
        body: { block: 4, on: false },
      });
    });

    // Seleciona aba Níveis e altera Volume do timbre
    fireEvent.click(screen.getByTestId('exp-select-levels'));
    fireEvent.change(screen.getByTestId('exp-slider-patchVolume'), {
      target: { value: '88' },
    });

    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        url: '/api/experimental/level',
        method: 'PUT',
        body: { target: 'patchVolume', value: 88 },
      });
    });

    // Passa a janela de proteção contra eco local (400ms) e recebe sync remoto via WS
    await new Promise((resolve) => setTimeout(resolve, 450));

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'experimental_state_sync',
        timestamp: new Date().toISOString(),
        state: {
          ...expState,
          blockParams: { ...expState.blockParams, '4': [50, 50, 91, 50, 50, 50] },
          patchVolume: 72,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('exp-slider-patchVolume')).toHaveValue('72');
    });

    // Fecha o drawer: dirty guard pede confirmação antes de descartar alterações locais
    fireEvent.click(screen.getByTestId('close-tone-editor-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('dirty-guard-banner')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('confirm-discard-dirty-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('experimental-edit-panel')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('create-tone-btn'));
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url === '/api/experimental/new')).toBe(true);
      expect(screen.getByTestId('offline-draft-notice')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('exp-preset-name-input'), {
      target: { value: 'Lead Stage' },
    });
    fireEvent.blur(screen.getByTestId('exp-preset-name-input'));

    fireEvent.click(screen.getByTestId('exp-save-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('inline-save-panel')).toBeInTheDocument();
    });
    const saveSlotSelect = screen.getByTestId('save-target-slot-select');
    const optionValues = Array.from(saveSlotSelect.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toHaveLength(36);
    expect(optionValues).not.toContain('36');

    fireEvent.change(saveSlotSelect, { target: { value: '16' } });
    expect(screen.getByTestId('inline-save-panel')).toHaveTextContent('RG J. Mayer');
    fireEvent.click(screen.getByTestId('exp-confirm-save-btn'));

    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        url: '/api/experimental/save',
        method: 'POST',
        body: { confirmSlot: 16 },
      });
    });

    // Fluxo Importar .nuxpreset -> exibe aviso de User IR quando preset usa CAB=100
    const fileInput = screen.getByTestId('exp-import-input') as HTMLInputElement;
    const fakeFile = new File([new Uint8Array([1, 2, 3, 4])], 'Shin on Crazy.nuxpreset', {
      type: 'application/octet-stream',
    });
    fireEvent.change(fileInput, { target: { files: [fakeFile] } });

    await waitFor(() => {
      expect(screen.getByTestId('exp-user-ir-warning')).toHaveTextContent('CustomV30');
    });
  });

  it('12. Logout de dispositivo confiável não entra em loop automático e exibe erro se reconexão falhar', async () => {
    currentPairingStatus = {
      isLocalDesktop: false,
      authenticated: true,
      sessionStatus: 'active',
      activeSession: {
        sessionId: 'sess-mobile',
        deviceName: 'Galaxy S25 Pedro',
        remoteIp: '192.168.1.88',
        createdAt: '2026-11-25T03:00:00.000Z',
        expiresAt: '2026-11-25T07:00:00.000Z',
        lastActivityAt: '2026-11-25T03:10:00.000Z',
      },
      pendingRequests: [],
      activeChallenge: null,
      lanUrls: [],
      isTrustedDevice: true,
      trustedDeviceName: 'Galaxy S25 Pedro',
    };

    let trustedLoginFail = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/pairing/logout')) {
        fetchCalls.push({ url, method: 'POST', body: {} });
        currentPairingStatus = {
          ...currentPairingStatus,
          authenticated: false,
          sessionStatus: 'none',
          activeSession: null,
        };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/api/pairing/trusted-login')) {
        fetchCalls.push({ url, method: 'POST', body: {} });
        if (trustedLoginFail) {
          return new Response(
            JSON.stringify({
              code: 'TRUSTED_DEVICE_INVALID',
              message: 'Dispositivo removido no computador.',
            }),
            { status: 401 },
          );
        }
        currentPairingStatus = {
          ...currentPairingStatus,
          authenticated: true,
          sessionStatus: 'active',
        };
        return new Response(JSON.stringify({ ok: true, session: null }), { status: 200 });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('open-settings-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-settings-btn'));
    fireEvent.click(screen.getByTestId('logout-mobile-btn'));

    // Deve permanecer no MobilePairingGate com botão manual sem disparar trusted-login automático
    await waitFor(() => {
      expect(screen.getByTestId('trusted-reconnect-btn')).toBeInTheDocument();
    });
    expect(
      fetchCalls.filter((c) => c.url.endsWith('/api/pairing/trusted-login')),
    ).toHaveLength(0);

    // Se a reconexão manual falhar, exibe o alerta pairing-error
    trustedLoginFail = true;
    fireEvent.click(screen.getByTestId('trusted-reconnect-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('pairing-error')).toHaveTextContent(
        'Dispositivo removido no computador.',
      );
    });
  });

  it('13. Regressões do editor: erro visível dentro do ToneEditorDrawer, cancelamento de timers em transições (<400ms), BPM/toggle/select/bundle e sanitização de erro HTML', async () => {
    let expState: Record<string, unknown> = {
      slot: 15,
      loaded: false,
      busy: false,
      dirty: false,
      sourceMode: 'hardware',
      sourceFileName: null,
      presetName: null,
      bpm: 120,
      timeFlag: 0,
      ampParams: [],
      blocksEnabled: [],
      blockModels: {},
      blockParams: {},
      cabEnabled: false,
      cabModel: 0,
      micModel: 0,
      irCut: 0,
      irVolume: 20,
      patchVolume: 50,
      hasUserIr: false,
      userIrName: null,
      userIrWarning: null,
      lastSave: null,
    };
    let failSave = true;

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (url.endsWith('/api/experimental/state')) {
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/load')) {
        expState = {
          ...expState,
          slot: 15,
          loaded: true,
          sourceMode: 'hardware',
          presetName: 'Stage Rig',
          bpm: 120,
          blockModels: { '1': 0, '2': 1, '3': 18, '4': 1, '5': 1, '6': 11, '7': 0, '8': 0, '9': 1, '10': 2 },
          blockParams: {
            '1': [50, 50, 0, 0, 0, 0],
            '2': [50, 50, 0, 0, 0, 0],
            '3': [60, 0, 50, 50, 50, 50],
            '4': [50, 50, 50, 50, 50, 50],
            '5': [40, 30, 0, 0, 0, 0],
            '6': [50, 50, 0, 0, 0, 0],
            '7': [50, 40, 35, 0, 0, 0],
            '8': [35, 50, 50, 0, 0, 0],
          },
          cabEnabled: true,
          cabModel: 1,
          micModel: 2,
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/block')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          dirty: true,
          blockModels: {
            ...(expState.blockModels as Record<string, number>),
            [String(body.block)]: body.on ? 1 : 0,
          },
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/block-param')) {
        fetchCalls.push({ url, method, body });
        const bp = { ...(expState.blockParams as Record<string, number[]>) };
        const arr = [...(bp[String(body.block)] ?? [0, 0, 0, 0, 0, 0])];
        arr[body.index] = body.value;
        bp[String(body.block)] = arr;
        expState = { ...expState, dirty: true, blockParams: bp };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/new')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          loaded: true,
          sourceMode: 'draft',
          presetName: 'New Preset',
          bpm: 120,
          blockModels: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 1, '6': 0, '7': 0, '8': 0, '9': 1, '10': 2 },
          blockParams: {
            '1': [50, 50, 0, 0, 0, 0],
            '2': [50, 50, 50, 50, 0, 0],
            '3': [50, 0, 50, 50, 50, 50],
            '4': [50, 50, 50, 50, 50, 50],
            '5': [40, 30, 0, 0, 0, 0],
            '6': [50, 50, 50, 0, 0, 0],
            '7': [50, 35, 35, 0, 0, 0],
            '8': [35, 50, 50, 0, 0, 0],
          },
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/meta')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          dirty: true,
          presetName: body.presetName ?? expState.presetName,
          bpm: body.bpm ?? expState.bpm,
          timeFlag: body.timeFlag ?? expState.timeFlag,
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/import')) {
        fetchCalls.push({ url, method, body });
        const idx = body.bundleSlotIndex ?? 0;
        expState = {
          ...expState,
          loaded: true,
          dirty: true,
          sourceMode: 'imported',
          presetName: idx === 1 ? 'Pack B' : 'Pack A',
        };
        return new Response(
          JSON.stringify({
            state: expState,
            importedCount: 2,
            selectedIndex: idx,
            bundleSlots: [
              { index: 0, slotIndex: 0, displayBank: '1A', name: 'Pack A', usesUserIr: false },
              { index: 1, slotIndex: 1, displayBank: '1B', name: 'Pack B', usesUserIr: false },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/experimental/discard')) {
        fetchCalls.push({ url, method, body });
        expState = { ...expState, loaded: false, dirty: false };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/save')) {
        fetchCalls.push({ url, method, body });
        if (failSave) {
          return new Response('<html><body>502 Bad Gateway</body></html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response(
          JSON.stringify({
            targetSlot: body.confirmSlot,
            displayBank: '4D',
            ackReceived: true,
            verified: true,
            mismatchedOffsets: [],
            backupPath: 'slot-15.json',
            savedAt: new Date().toISOString(),
          }),
          { status: 200 },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1A')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('preset-card-1A'));
    await waitFor(() => {
      expect(screen.getByTestId('open-tone-editor-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('open-tone-editor-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-slider-AMP-0')).toBeInTheDocument();
    });

    // 1) Toggle AMP Bright (index 1)
    fireEvent.click(screen.getByTestId('exp-toggle-param-AMP-1'));
    await waitFor(() => {
      expect(fetchCalls).toContainEqual({
        url: '/api/experimental/block-param',
        method: 'PUT',
        body: { block: 3, index: 1, value: 1 },
      });
    });

    // 2) Move fader and IMMEDIATELY (<400ms) click "Desligar": UI must switch to Ligar and cancel pending fader send
    const countBefore = fetchCalls.filter((c) => c.url === '/api/experimental/block-param').length;
    fireEvent.change(screen.getByTestId('exp-slider-AMP-0'), { target: { value: '99' } });
    fireEvent.click(screen.getByTestId('exp-toggle-block-AMP'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-toggle-block-AMP')).toHaveTextContent('Ligar');
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchCalls.filter((c) => c.url === '/api/experimental/block-param')).toHaveLength(
      countBefore,
    );

    // 3) BPM input allows clearing and typing new value without snapping back to 120
    const bpmInput = screen.getByTestId('exp-bpm-input') as HTMLInputElement;
    fireEvent.change(bpmInput, { target: { value: '' } });
    expect(bpmInput.value).toBe('');
    fireEvent.change(bpmInput, { target: { value: '142' } });
    fireEvent.blur(bpmInput);
    await waitFor(() => {
      expect(bpmInput.value).toBe('142');
      expect(fetchCalls.some((c) => c.url === '/api/experimental/meta' && (c.body as { bpm?: number })?.bpm === 142)).toBe(true);
    });

    // 4) Import 36-slot bundle (now protected by dirty-guard!) and switch slot inside bundle
    const fileInput = screen.getByTestId('exp-import-input') as HTMLInputElement;
    const bundleFile = new File([new Uint8Array([1, 2, 3, 4])], 'MG300AllPreset.nuxpreset', {
      type: 'application/octet-stream',
    });
    fireEvent.change(fileInput, { target: { files: [bundleFile] } });
    await waitFor(() => {
      expect(screen.getByTestId('dirty-guard-banner')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('confirm-discard-dirty-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-bundle-slot-select')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('exp-bundle-slot-select'), { target: { value: '1' } });
    await waitFor(() => {
      expect((screen.getByTestId('exp-preset-name-input') as HTMLInputElement).value).toBe('Pack B');
    });

    // 5) Save failure (HTML 502) surfaces sanitized error INSIDE Drawer footer without leaking raw HTML
    fireEvent.click(screen.getByTestId('exp-save-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('inline-save-panel')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('exp-confirm-save-btn'));
    await waitFor(() => {
      const drawerPanel = screen.getByTestId('experimental-edit-panel');
      const alert = drawerPanel.querySelector('[role="alert"]');
      expect(alert).toHaveTextContent('Erro na comunicação com o servidor (HTTP 502)');
      expect(alert?.textContent).not.toContain('<html>');
    });

    // Escape closes inline-save-panel first, then opens dirty guard, then discards cleanly
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('inline-save-panel')).not.toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getByTestId('dirty-guard-banner')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('confirm-discard-dirty-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('experimental-edit-panel')).not.toBeInTheDocument();
    });
  });

  it('14. Rascunho offline (Criar novo timbre) e .nuxpreset importado NÃO sobrescrevem os chips do StageDisplay', async () => {
    currentPresetsResponse = buildPresetsResponse({
      presets: [
        {
          ...MOCK_PRESETS[0]!,
          signalChain: {
            compEnabled: true,
            efxEnabled: false,
            ampEnabled: true,
            irEnabled: true,
            eqEnabled: false,
            nrEnabled: true,
            modEnabled: false,
            dlyEnabled: true,
            rvbEnabled: false,
          },
        },
        ...MOCK_PRESETS.slice(1),
      ],
    });

    let expState: Record<string, unknown> = {
      slot: 0,
      loaded: false,
      busy: false,
      dirty: false,
      sourceMode: 'hardware',
      sourceFileName: null,
      presetName: null,
      bpm: 120,
      timeFlag: 0,
      ampParams: [],
      blocksEnabled: [],
      blockModels: {},
      blockParams: {},
      cabEnabled: false,
      cabModel: 0,
      micModel: 0,
      irCut: 0,
      irVolume: 20,
      patchVolume: 50,
      hasUserIr: false,
      userIrName: null,
      userIrWarning: null,
      lastSave: null,
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/experimental/state')) {
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/new')) {
        expState = {
          ...expState,
          slot: 0,
          loaded: true,
          dirty: true,
          sourceMode: 'draft',
          presetName: 'Novo Timbre',
          blockModels: { '1': 0, '2': 1, '3': 1, '4': 1, '5': 0, '6': 1, '7': 0, '8': 1, '9': 1, '10': 2 },
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/import')) {
        expState = {
          ...expState,
          slot: 0,
          loaded: true,
          dirty: true,
          sourceMode: 'imported',
          presetName: 'Imported Rig',
          blockModels: { '1': 0, '2': 1, '3': 1, '4': 1, '5': 0, '6': 1, '7': 0, '8': 1, '9': 1, '10': 2 },
        };
        return new Response(
          JSON.stringify({ state: expState, importedCount: 1, selectedIndex: 0 }),
          { status: 200 },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('stage-display')).toHaveTextContent('EaglesDF Crunch');
    });

    const strip = screen.getByTestId('signal-chain-strip');
    expect(strip.querySelector('[data-block="COMP"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="EFX"]')?.getAttribute('data-active')).toBe('false');
    expect(strip.querySelector('[data-block="DLY"]')?.getAttribute('data-active')).toBe('true');

    // Abre Criar novo timbre (draft com COMP=0, EFX=1, DLY=0) -> StageDisplay preserva o hardware 1A
    fireEvent.click(screen.getByTestId('create-tone-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('offline-draft-notice')).toBeInTheDocument();
    });
    expect(strip.querySelector('[data-block="COMP"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="EFX"]')?.getAttribute('data-active')).toBe('false');
    expect(strip.querySelector('[data-block="DLY"]')?.getAttribute('data-active')).toBe('true');

    // Importa .nuxpreset (aciona dirty-guard sobre o rascunho) -> StageDisplay continua preservando o hardware 1A
    const fileInput = screen.getByTestId('exp-import-input') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'rig.nuxpreset', {
      type: 'application/octet-stream',
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByTestId('dirty-guard-banner')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('confirm-discard-dirty-btn'));
    await waitFor(() => {
      expect((screen.getByTestId('exp-preset-name-input') as HTMLInputElement).value).toBe('Imported Rig');
    });
    expect(strip.querySelector('[data-block="COMP"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="EFX"]')?.getAttribute('data-active')).toBe('false');
    expect(strip.querySelector('[data-block="DLY"]')?.getAttribute('data-active')).toBe('true');
  });

  it('15. Descartar alterações ao fechar hardware editor recarrega slot limpo, limpa dirty e desativa beforeunload', async () => {
    let expState: Record<string, unknown> = {
      slot: 0,
      loaded: false,
      busy: false,
      dirty: false,
      sourceMode: 'hardware',
      sourceFileName: null,
      presetName: null,
      bpm: 120,
      timeFlag: 0,
      ampParams: [],
      blocksEnabled: [],
      blockModels: {},
      blockParams: {},
      cabEnabled: true,
      cabModel: 1,
      micModel: 2,
      irCut: 0,
      irVolume: 20,
      patchVolume: 50,
      hasUserIr: false,
      userIrName: null,
      userIrWarning: null,
      lastSave: null,
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.endsWith('/api/experimental/state')) {
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/load')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          slot: body.slot ?? 0,
          loaded: true,
          dirty: false,
          sourceMode: 'hardware',
          presetName: 'EaglesDF Crunch',
          blockModels: { '1': 1, '2': 0, '3': 1, '4': 0, '5': 1, '6': 0, '7': 0, '8': 0, '9': 1, '10': 2 },
          blockParams: { '3': [50, 0, 50, 50, 50, 50] },
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/block')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          dirty: true,
          blockModels: {
            ...(expState.blockModels as Record<string, number>),
            [String(body.block)]: body.on ? 1 : 0,
          },
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('open-tone-editor-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-tone-editor-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-toggle-block-AMP')).toBeInTheDocument();
    });

    // Suja estado de hardware desligando AMP -> StageDisplay acompanha e beforeunload fica ativo
    fireEvent.click(screen.getByTestId('exp-toggle-block-AMP'));
    await waitFor(() => {
      expect(
        screen.getByTestId('signal-chain-strip').querySelector('[data-block="AMP"]')?.getAttribute('data-active'),
      ).toBe('false');
    });

    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    // Fechar e confirmar descarte recarrega o slot 0 da Flash e limpa beforeunload
    const loadsBeforeDiscard = fetchCalls.filter((c) => c.url.endsWith('/api/experimental/load')).length;
    fireEvent.click(screen.getByTestId('close-tone-editor-btn'));
    expect(screen.getByTestId('dirty-guard-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-discard-dirty-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('experimental-edit-panel')).not.toBeInTheDocument();
      expect(fetchCalls.filter((c) => c.url.endsWith('/api/experimental/load'))).toHaveLength(
        loadsBeforeDiscard + 1,
      );
    });

    expect(
      screen.getByTestId('signal-chain-strip').querySelector('[data-block="AMP"]')?.getAttribute('data-active'),
    ).toBe('true');

    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it('16. Dirty guard aciona em switch_slot, reload, import e troca de item editado em bundle (Continuar e Descartar)', async () => {
    let expState: Record<string, unknown> = {
      slot: 0,
      loaded: false,
      busy: false,
      dirty: false,
      sourceMode: 'hardware',
      sourceFileName: null,
      presetName: null,
      bpm: 120,
      timeFlag: 0,
      ampParams: [],
      blocksEnabled: [],
      blockModels: {},
      blockParams: {},
      cabEnabled: true,
      cabModel: 1,
      micModel: 2,
      irCut: 0,
      irVolume: 20,
      patchVolume: 50,
      hasUserIr: false,
      userIrName: null,
      userIrWarning: null,
      lastSave: null,
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.endsWith('/api/experimental/state')) {
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/load')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          slot: body.slot ?? 0,
          loaded: true,
          dirty: false,
          sourceMode: 'hardware',
          presetName: body.slot === 1 ? 'SCORPIONS' : 'EaglesDF Crunch',
          blockModels: { '1': 1, '2': 0, '3': 1, '4': 0, '5': 1, '6': 0, '7': 0, '8': 0, '9': 1, '10': 2 },
          blockParams: { '3': [50, 0, 50, 50, 50, 50] },
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/block')) {
        fetchCalls.push({ url, method, body });
        expState = {
          ...expState,
          dirty: true,
          blockModels: {
            ...(expState.blockModels as Record<string, number>),
            [String(body.block)]: body.on ? 1 : 0,
          },
        };
        return new Response(JSON.stringify(expState), { status: 200 });
      }
      if (url.endsWith('/api/experimental/import')) {
        fetchCalls.push({ url, method, body });
        const idx = body.bundleSlotIndex ?? 0;
        expState = {
          ...expState,
          loaded: true,
          dirty: true,
          sourceMode: 'imported',
          presetName: idx === 1 ? 'Pack B' : 'Pack A',
          blockModels: { '1': 1, '2': 0, '3': 1, '4': 0, '5': 1, '6': 0, '7': 0, '8': 0, '9': 1, '10': 2 },
          blockParams: { '3': [50, 0, 50, 50, 50, 50] },
        };
        return new Response(
          JSON.stringify({
            state: expState,
            importedCount: 2,
            selectedIndex: idx,
            bundleSlots: [
              { index: 0, slotIndex: 0, displayBank: '1A', name: 'Pack A', usesUserIr: false },
              { index: 1, slotIndex: 1, displayBank: '1B', name: 'Pack B', usesUserIr: false },
            ],
          }),
          { status: 200 },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('open-tone-editor-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('open-tone-editor-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-toggle-block-AMP')).toBeInTheDocument();
    });

    // Dirty em slot 0 -> switch_slot para slot 1 dispara dirty-guard; "Continuar editando" cancela troca
    fireEvent.click(screen.getByTestId('exp-toggle-block-AMP'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-reload-slot-btn')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('exp-load-slot-select'), { target: { value: '1' } });
    expect(screen.getByTestId('dirty-guard-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar editando' }));
    expect(screen.queryByTestId('dirty-guard-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('experimental-edit-panel')).toHaveTextContent('1A');

    // switch_slot confirmado troca para 1B
    fireEvent.change(screen.getByTestId('exp-load-slot-select'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('confirm-discard-dirty-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('experimental-edit-panel')).toHaveTextContent('1B');
    });

    // Dirty -> reload confirmado recarrega slot 1
    fireEvent.click(screen.getByTestId('exp-toggle-block-AMP'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-reload-slot-btn')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('exp-reload-slot-btn'));
    expect(screen.getByTestId('dirty-guard-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-discard-dirty-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('exp-reload-slot-btn')).not.toBeInTheDocument();
    });

    // Dirty -> importar arquivo dispara dirty-guard
    fireEvent.click(screen.getByTestId('exp-toggle-block-AMP'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-reload-slot-btn')).toBeInTheDocument();
    });
    const fileInput = screen.getByTestId('exp-import-input') as HTMLInputElement;
    const bundleFile = new File([new Uint8Array([1, 2, 3, 4])], 'bundle.nuxpreset', {
      type: 'application/octet-stream',
    });
    fireEvent.change(fileInput, { target: { files: [bundleFile] } });
    expect(screen.getByTestId('dirty-guard-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-discard-dirty-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('exp-bundle-slot-select')).toBeInTheDocument();
    });

    // Editar item do pacote -> trocar item no pacote dispara dirty-guard
    fireEvent.click(screen.getByTestId('exp-toggle-block-AMP'));
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url.endsWith('/api/experimental/block'))).toBe(true);
    });
    fireEvent.change(screen.getByTestId('exp-bundle-slot-select'), { target: { value: '1' } });
    expect(screen.getByTestId('dirty-guard-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-discard-dirty-btn'));
    await waitFor(() => {
      expect((screen.getByTestId('exp-preset-name-input') as HTMLInputElement).value).toBe('Pack B');
    });
  });

  it('17. Erros com !loaded (loadSlot rejeitado ou upload > 512 KB) ficam visíveis com role="alert" no ToneEditorDrawer', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/experimental/state')) {
        return new Response(
          JSON.stringify({
            slot: 0,
            loaded: false,
            busy: false,
            dirty: false,
            sourceMode: 'hardware',
            sourceFileName: null,
            presetName: null,
            bpm: 120,
            timeFlag: 0,
            ampParams: [],
            blocksEnabled: [],
            blockModels: {},
            blockParams: {},
            cabEnabled: false,
            cabModel: 0,
            micModel: 0,
            irCut: 0,
            irVolume: 20,
            patchVolume: 50,
            hasUserIr: false,
            userIrName: null,
            userIrWarning: null,
            lastSave: null,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/experimental/load')) {
        return new Response(
          JSON.stringify({ code: 'DEVICE_OFFLINE', message: 'Pedaleira desconectada ao carregar slot.' }),
          { status: 503 },
        );
      }
      return origFetch(input);
    }) as typeof fetch;

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('open-tone-editor-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-tone-editor-btn'));
    await waitFor(() => {
      const panel = screen.getByTestId('experimental-edit-panel');
      expect(panel.querySelector('[role="alert"]')).toHaveTextContent(
        'Pedaleira desconectada ao carregar slot.',
      );
    });

    // Upload > 512 KB com !loaded também exibe alerta visível
    const oversized = new File([new Uint8Array(520 * 1024)], 'huge.nuxpreset', {
      type: 'application/octet-stream',
    });
    fireEvent.change(screen.getByTestId('exp-import-input'), { target: { files: [oversized] } });
    await waitFor(() => {
      const panel = screen.getByTestId('experimental-edit-panel');
      expect(panel.querySelector('[role="alert"]')).toHaveTextContent('512 KB');
    });
  });

  it('18. Preset de Fábrica (F1A) ativo: chips do StageDisplay não são botões, tecla "e" não abre editor e Criar novo timbre abre rascunho offline', async () => {
    currentState = buildMockState({
      confirmedState: {
        presetId: 'F1A',
        slotIndex: 36,
        volume: 50,
        volumeTarget: 'master_cc64',
        confirmedAt: '2026-11-23T20:00:00.000Z',
      },
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/experimental/new')) {
        return new Response(
          JSON.stringify({
            slot: 15,
            loaded: true,
            busy: false,
            dirty: true,
            sourceMode: 'draft',
            sourceFileName: null,
            presetName: 'Novo Timbre',
            bpm: 120,
            timeFlag: 0,
            ampParams: [50, 0, 50, 50, 50, 50],
            blocksEnabled: [false, false, true, false, true, false, false, false],
            blockModels: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 1, '6': 0, '7': 0, '8': 0, '9': 1, '10': 2 },
            blockParams: { '3': [50, 0, 50, 50, 50, 50] },
            cabEnabled: true,
            cabModel: 1,
            micModel: 2,
            irCut: 0,
            irVolume: 20,
            patchVolume: 50,
            hasUserIr: false,
            userIrName: null,
            userIrWarning: null,
            lastSave: null,
          }),
          { status: 200 },
        );
      }
      return origFetch(input);
    }) as typeof fetch;

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('stage-display')).toHaveTextContent('F1A');
    });

    expect(screen.queryByTestId('open-tone-editor-btn')).not.toBeInTheDocument();
    const strip = screen.getByTestId('signal-chain-strip');
    expect(strip.querySelectorAll('button')).toHaveLength(0);
    expect(strip.querySelectorAll('[data-block]')).toHaveLength(10);

    // Atalho 'e' não deve abrir o drawer para preset de Fábrica
    fireEvent.keyDown(window, { key: 'e' });
    expect(screen.queryByTestId('experimental-edit-panel')).not.toBeInTheDocument();

    // Criar novo timbre segue disponível e abre rascunho offline
    fireEvent.click(screen.getByTestId('create-tone-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('experimental-edit-panel')).toBeInTheDocument();
      expect(screen.getByTestId('offline-draft-notice')).toBeInTheDocument();
    });
  });
});
