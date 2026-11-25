import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ControllerState,
  Preset,
  PresetsResponse,
  WsServerMessage,
} from '@quicktone/shared';
import { App } from '../App.js';

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
    sourceFile: 'EaglesDF Crunch.nuxpreset',
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
    sourceFile: 'SCORPIONS.nuxpreset',
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
    id: 'F1A',
    slotIndex: 36,
    bankType: 'factory',
    bankNumber: 1,
    patchLetter: 'A',
    displayBank: 'F1A',
    name: 'CT 80JM Drive',
    patchVolume: 50,
    isDuplicate: false,
    updatedAt: '2026-11-23T20:00:00.000Z',
    midiMapping: {
      protocol: 'mg300-cc60',
      channel: 0,
      ccNumber: 60,
      ccValue: 36,
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
    presetsDirectory: 'C:\\Users\\pedro\\Documents\\NUX\\QuickTone',
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
    directory: 'C:\\Users\\pedro\\Documents\\NUX\\QuickTone',
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
  public onclose: (() => void) | null = null;

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

  public triggerClose(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
}

interface FetchCallRecord {
  url: string;
  method: string;
  body: unknown;
}

describe('@quicktone/frontend — Testes Unitários da Interface (Seção 7)', () => {
  let currentState: ControllerState;
  let currentPresetsResponse: PresetsResponse;
  let fetchCalls: FetchCallRecord[];
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    fetchCalls = [];
    currentState = buildMockState();
    currentPresetsResponse = buildPresetsResponse();

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const parsedBody =
        typeof init?.body === 'string' && init.body.length > 0
          ? (JSON.parse(init.body) as unknown)
          : null;

      fetchCalls.push({ url, method, body: parsedBody });

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
          volumeTarget: body.target ?? 'master_cc64',
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

      if (
        (url.endsWith('/api/presets/config') || url.endsWith('/api/config/presets-dir')) &&
        method === 'POST'
      ) {
        const body = parsedBody as { directoryPath: string };
        currentState = {
          ...currentState,
          presetsDirectory: body.directoryPath,
          presetsDirectoryStatus: 'ok',
        };
        return new Response(
          JSON.stringify({
            state: currentState,
            ...currentPresetsResponse,
            directory: body.directoryPath,
          }),
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

  it('1. Renderização do grid de presets: exibe banco, número (1A, 1B, F1A) e nomes com filtro de bancos', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1A')).toBeInTheDocument();
    });

    // Verifica identificação destacada de banco, número e nome de cada preset
    expect(screen.getByTestId('preset-bank-1A')).toHaveTextContent('1A');
    expect(screen.getByTestId('preset-name-1A')).toHaveTextContent('EaglesDF Crunch');

    expect(screen.getByTestId('preset-bank-1B')).toHaveTextContent('1B');
    expect(screen.getByTestId('preset-name-1B')).toHaveTextContent('SCORPIONS');

    expect(screen.getByTestId('preset-bank-F1A')).toHaveTextContent('F1A');
    expect(screen.getByTestId('preset-name-F1A')).toHaveTextContent('CT 80JM Drive');

    // Filtra apenas presets de Fábrica (F1A..F9D)
    fireEvent.click(screen.getByTestId('filter-tab-factory'));
    expect(screen.queryByTestId('preset-card-1A')).not.toBeInTheDocument();
    expect(screen.getByTestId('preset-card-F1A')).toBeInTheDocument();

    // Filtra apenas presets de Usuário (1A..9D)
    fireEvent.click(screen.getByTestId('filter-tab-user'));
    expect(screen.getByTestId('preset-card-1A')).toBeInTheDocument();
    expect(screen.getByTestId('preset-card-1B')).toBeInTheDocument();
    expect(screen.queryByTestId('preset-card-F1A')).not.toBeInTheDocument();
  });

  it('2. Seleção de preset: clique dispara POST /api/presets/select, exibe "COMANDO ENVIADO" sem falsificar confirmação e atualiza para "CONFIRMADO" quando a pedaleira confirma', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1A')).toHaveAttribute(
        'data-status',
        'confirmed',
      );
    });
    expect(screen.getByTestId('preset-status-confirmed-1A')).toHaveTextContent(
      'CONFIRMADO',
    );

    // Clica no preset 1B ("SCORPIONS")
    fireEvent.click(screen.getByTestId('preset-card-1B'));

    await waitFor(() => {
      const selectCall = fetchCalls.find(
        (c) => c.url.endsWith('/api/presets/select') && c.method === 'POST',
      );
      expect(selectCall).toBeDefined();
      expect(selectCall?.body).toEqual({ presetId: '1B', slotIndex: 1 });
    });

    // O preset 1B deve aparecer como "COMANDO ENVIADO" (não confirmado)
    await waitFor(() => {
      expect(screen.getByTestId('preset-card-1B')).toHaveAttribute(
        'data-status',
        'command_sent_unconfirmed',
      );
    });
    expect(screen.getByTestId('preset-status-sent-1B')).toHaveTextContent(
      'COMANDO ENVIADO',
    );
    expect(screen.getByTestId('device-sync-badge')).toHaveAttribute(
      'data-sync-status',
      'command_sent_unconfirmed',
    );
    expect(screen.getByTestId('device-sync-badge')).toHaveTextContent(
      'Comando enviado (aguardando confirmação)',
    );

    // Agora simula confirmação real da pedaleira via WebSocket (MIDI IN CC 60 = 1)
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
    expect(screen.getByTestId('preset-status-confirmed-1B')).toHaveTextContent(
      'CONFIRMADO',
    );
    expect(screen.getByTestId('device-sync-badge')).toHaveAttribute(
      'data-sync-status',
      'confirmed',
    );
  });

  it('3. Slider de volume: alteração dispara PUT /api/volume com valor 0..100 e diferencia volume enviado vs confirmado', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('volume-slider')).toBeInTheDocument();
    });

    const slider = screen.getByLabelText('Volume Master');
    fireEvent.change(slider, { target: { value: '78' } });

    await waitFor(() => {
      const volCall = fetchCalls.find(
        (c) => c.url.endsWith('/api/volume') && c.method === 'PUT',
      );
      expect(volCall).toBeDefined();
      expect(volCall?.body).toEqual({
        volume: 78,
        target: 'master_cc64',
      });
    });

    expect(screen.getByTestId('volume-value')).toHaveTextContent('78%');
    expect(screen.getByTestId('sent-volume-badge')).toHaveTextContent('Enviado: 78%');
    expect(screen.getByTestId('confirmed-volume-badge')).toHaveTextContent(
      'Confirmado: 50%',
    );
  });

  it('4. Estado de conexão e Tri-State: exibe conectado, desconectado e os 3 estados de sincronização da pedaleira', async () => {
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
    expect(screen.getByTestId('midi-connection-badge')).toHaveTextContent(
      'MIDI Desconectado',
    );
    expect(screen.getByTestId('device-sync-badge')).toHaveAttribute(
      'data-sync-status',
      'unknown',
    );
    expect(screen.getByTestId('device-sync-badge')).toHaveTextContent(
      'Estado da pedaleira desconhecido',
    );

    // Transição via WebSocket para conectado + comando enviado não confirmado
    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'state_sync',
        timestamp: '2026-11-23T20:03:00.000Z',
        state: buildMockState({
          connectionState: 'connected',
          connectedPortName: 'NUX NME-300',
          syncStatus: 'command_sent_unconfirmed',
          lastSentCommand: {
            commandId: 'cmd-99',
            type: 'preset_select',
            presetId: 'F1A',
            slotIndex: 36,
            midiBytes: [0xb0, 0x3c, 36],
            sentAt: '2026-11-23T20:03:00.000Z',
            confirmedByDevice: false,
          },
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('midi-connection-badge')).toHaveAttribute(
        'data-connection-state',
        'connected',
      );
      expect(screen.getByTestId('device-sync-badge')).toHaveAttribute(
        'data-sync-status',
        'command_sent_unconfirmed',
      );
    });

    // Transição para confirmado pela pedaleira
    act(() => {
      ws.triggerMessage({
        type: 'state_sync',
        timestamp: '2026-11-23T20:03:02.000Z',
        state: buildMockState({
          connectionState: 'connected',
          connectedPortName: 'NUX NME-300',
          syncStatus: 'confirmed',
          confirmedState: {
            presetId: 'F1A',
            slotIndex: 36,
            volume: 50,
            volumeTarget: 'master_cc64',
            confirmedAt: '2026-11-23T20:03:02.000Z',
          },
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('device-sync-badge')).toHaveAttribute(
        'data-sync-status',
        'confirmed',
      );
      expect(screen.getByTestId('confirmed-preset-indicator')).toHaveTextContent('F1A');
    });
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
      expect(screen.getByTestId('ws-connection-badge')).toHaveTextContent('WS Online');
    });

    // Atualiza o estado no servidor enquanto o WS cai
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

    // Simula queda abrupta do WebSocket
    act(() => {
      firstWs.triggerClose();
    });

    await waitFor(() => {
      expect(screen.getByTestId('ws-connection-badge')).toHaveAttribute(
        'data-ws-status',
        'reconnecting',
      );
      expect(screen.getByTestId('ws-connection-badge')).toHaveTextContent(
        'Reconectando WS...',
      );
    });

    // Aguarda nova tentativa automática de conexão WebSocket
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
      expect(screen.getByTestId('confirmed-preset-indicator')).toHaveTextContent('F1A');
      expect(screen.getByTestId('volume-value')).toHaveTextContent('85%');
    });
  });

  it('6. Exibição de erros: exibe alertas claros quando MIDI falha (PORT_BUSY / DEVICE_NOT_FOUND) ou pasta QuickTone não existe', async () => {
    currentState = buildMockState({
      connectionState: 'error',
      connectedPortName: null,
      presetsDirectory: 'C:\\Pasta\\Inexistente',
      presetsDirectoryStatus: 'directory_not_found',
      lastError: {
        code: 'PORT_BUSY',
        message: 'A porta USB-MIDI NUX NME-300 está ocupada por outro processo.',
        timestamp: '2026-11-23T20:05:00.000Z',
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('error-banner')).toBeInTheDocument();
    });

    const alertBanner = screen.getByTestId('error-banner');
    expect(alertBanner).toHaveAttribute('role', 'alert');
    expect(alertBanner).toHaveAttribute('data-error-code', 'PORT_BUSY');
    expect(alertBanner).toHaveTextContent(
      'A porta USB-MIDI NUX NME-300 está ocupada por outro processo.',
    );

    // Ao fechar o erro MIDI, exibe o alerta de diretório QuickTone não encontrado
    fireEvent.click(screen.getByTestId('dismiss-error-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('directory-error-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('directory-error-banner')).toHaveTextContent(
      'C:\\Pasta\\Inexistente',
    );
  });
});
