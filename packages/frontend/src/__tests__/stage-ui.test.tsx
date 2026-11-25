import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerState, Preset } from '@quicktone/shared';
import { generateQrMatrix } from '../utils/qr-code';
import { StageDisplay } from '../components/StageDisplay';
import { PresetGrid } from '../components/PresetGrid';
import { QrCodeSvg } from '../components/QrCodeSvg';
import App from '../App';

const SAMPLE_PRESETS: Preset[] = [
  {
    id: '1A',
    slotIndex: 0,
    bankType: 'user',
    bankNumber: 1,
    patchLetter: 'A',
    displayBank: '1A',
    name: 'EaglesDF Crunch',
    patchVolume: 64,
    irVolume: 20,
    origin: 'hardware',
    signalChain: {
      compEnabled: true,
      efxEnabled: false,
      ampEnabled: true,
      irEnabled: true,
      eqEnabled: false,
      nrEnabled: true,
      modEnabled: false,
      dlyEnabled: true,
      rvbEnabled: true,
    },
    isDuplicate: false,
    updatedAt: '2026-11-24T00:00:00.000Z',
    midiMapping: { protocol: 'mg300-cc60', channel: 0, ccNumber: 60, ccValue: 0 },
  },
  {
    id: '2A',
    slotIndex: 4,
    bankType: 'user',
    bankNumber: 2,
    patchLetter: 'A',
    displayBank: '2A',
    name: 'Lead 80s',
    patchVolume: 70,
    origin: 'file',
    isDuplicate: false,
    updatedAt: '2026-11-24T00:00:00.000Z',
    midiMapping: { protocol: 'mg300-cc60', channel: 0, ccNumber: 60, ccValue: 4 },
  },
];

describe('QuickTone Stage Hardware UI Components (unslop)', () => {
  it('generates a valid ISO/IEC 18004 QR matrix with finder patterns and dark module', () => {
    const matrix = generateQrMatrix('http://192.168.1.50:3001');
    expect(matrix).not.toBeNull();
    if (!matrix) return;

    expect(matrix.size).toBe(25);
    // Top-left finder core and ring
    expect(matrix.modules[0]?.[0]).toBe(true);
    expect(matrix.modules[1]?.[1]).toBe(false);
    expect(matrix.modules[3]?.[3]).toBe(true);
    // ISO/IEC 18004 EC Level L (01) + Mask 0 (000) -> 0x77C4 -> MSB-first top-left format bits [1,1,1,0,1,1,1]
    expect([
      matrix.modules[8]?.[0],
      matrix.modules[8]?.[1],
      matrix.modules[8]?.[2],
      matrix.modules[8]?.[3],
      matrix.modules[8]?.[4],
      matrix.modules[8]?.[5],
      matrix.modules[8]?.[7],
    ]).toEqual([true, true, true, false, true, true, true]);
    // Mandatory dark module
    expect(matrix.modules[matrix.size - 8]?.[8]).toBe(true);

    render(<QrCodeSvg value="http://192.168.1.50:3001" />);
    expect(screen.getByTestId('lan-qr-svg')).toBeInTheDocument();
  });

  it('renders StageDisplay with active preset name and read-only signal-chain-strip', () => {
    render(
      <StageDisplay
        activePreset={SAMPLE_PRESETS[0]!}
        syncStatus="confirmed"
        confirmedState={{
          presetId: '1A',
          slotIndex: 0,
          volume: 50,
          volumeTarget: 'master_cc64',
          confirmedAt: '2026-11-24T00:00:00.000Z',
        }}
        lastSentCommand={null}
      />,
    );

    expect(screen.getByTestId('stage-display')).toBeInTheDocument();
    expect(screen.getByText('EaglesDF Crunch')).toBeInTheDocument();
    const strip = screen.getByTestId('signal-chain-strip');
    expect(strip.querySelector('[data-block="COMP"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="EFX"]')?.getAttribute('data-active')).toBe('false');
    expect(strip.querySelector('[data-block="DLY"]')?.getAttribute('data-active')).toBe('true');
  });

  it('supports switching between Stage Footswitch Deck (A-D) and Bank Matrix (1-9) and Version 5 QR codes', () => {
    const pairingMatrix = generateQrMatrix('http://192.168.100.254:5173/?pair=AbCdEfGhIjKlMnOpQrSt');
    expect(pairingMatrix).not.toBeNull();

    const onChangeViewMode = vi.fn();
    const { rerender } = render(
      <PresetGrid
        presets={SAMPLE_PRESETS}
        filter="user"
        viewMode="stage"
        onChangeFilter={vi.fn()}
        onChangeViewMode={onChangeViewMode}
        confirmedState={{
          presetId: '1A',
          slotIndex: 0,
          volume: null,
          volumeTarget: null,
          confirmedAt: null,
        }}
        lastSentCommand={null}
        disabled={false}
        onSelectPreset={vi.fn()}
      />,
    );

    expect(screen.getByTestId('stage-footswitch-deck')).toBeInTheDocument();
    expect(screen.getByTestId('stage-bank-label')).toHaveTextContent('BANCO 1 (1A–1D)');

    fireEvent.click(screen.getByTestId('stage-bank-next-btn'));
    expect(screen.getByTestId('stage-bank-label')).toHaveTextContent('BANCO 2 (2A–2D)');

    fireEvent.click(screen.getByTestId('view-mode-matrix-btn'));
    expect(onChangeViewMode).toHaveBeenCalledWith('matrix');

    rerender(
      <PresetGrid
        presets={SAMPLE_PRESETS}
        filter="user"
        viewMode="matrix"
        onChangeFilter={vi.fn()}
        onChangeViewMode={onChangeViewMode}
        confirmedState={{
          presetId: '1A',
          slotIndex: 0,
          volume: null,
          volumeTarget: null,
          confirmedAt: null,
        }}
        lastSentCommand={null}
        disabled={false}
        onSelectPreset={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('stage-footswitch-deck')).not.toBeInTheDocument();
    expect(screen.getByTestId('preset-card-1A')).toBeInTheDocument();
    expect(screen.getByTestId('preset-card-2A')).toBeInTheDocument();
  });

  describe('App activePreset pending transition', () => {
    afterEach(() => {
      cleanup();
      vi.unstubAllGlobals();
    });

    it('immediately updates StageDisplay to pending preset when switching away from an already confirmed preset', async () => {
      const confirmed1AState: ControllerState = {
        connectionState: 'connected',
        connectedPortName: 'NUX NME-300',
        availablePorts: [],
        syncStatus: 'confirmed',
        confirmedState: {
          presetId: '1A',
          slotIndex: 0,
          volume: 50,
          volumeTarget: 'master_cc64',
          confirmedAt: '2026-11-24T00:00:00.000Z',
        },
        lastSentCommand: null,
        volumeTarget: 'master_cc64',
        presetsDirectory: null,
        presetsDirectoryStatus: 'ok',
        presetCount: 2,
        warnings: [],
        authRequired: false,
        lastError: null,
      };

      const pending2AState: ControllerState = {
        ...confirmed1AState,
        syncStatus: 'command_sent_unconfirmed',
        lastSentCommand: {
          commandId: 'cmd-2',
          type: 'preset_select',
          presetId: '2A',
          slotIndex: 4,
          midiBytes: [0xb0, 0x3c, 4],
          sentAt: '2026-11-24T00:00:01.000Z',
          confirmedByDevice: false,
        },
      };

      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/api/status')) {
            return new Response(JSON.stringify(confirmed1AState), { status: 200 });
          }
          if (url.endsWith('/api/presets')) {
            return new Response(
              JSON.stringify({
                presets: SAMPLE_PRESETS,
                directory: null,
                directoryStatus: 'ok',
                warnings: [],
              }),
              { status: 200 },
            );
          }
          if (url.endsWith('/api/presets/select')) {
            return new Response(JSON.stringify({ state: pending2AState }), { status: 200 });
          }
          return new Response(JSON.stringify({}), { status: 404 });
        }),
      );

      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId('stage-display')).toHaveTextContent('EaglesDF Crunch');
      });

      fireEvent.click(screen.getByTestId('preset-card-2A'));
      await waitFor(() => {
        expect(screen.getByTestId('stage-display')).toHaveTextContent('Lead 80s');
        expect(screen.getByTestId('stage-display')).toHaveTextContent('COMANDO ENVIADO');
      });
    });

    it('triggers POST /api/presets/reload from Sincronizar button and opens QR pairing in SettingsModal without folder or fader controls', async () => {
      const fetchCalls: Array<{ url: string; body: unknown }> = [];
      const baseState: ControllerState = {
        connectionState: 'connected',
        connectedPortName: 'NUX NME-300',
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
        presetCount: 2,
        warnings: [],
        authRequired: false,
        lastError: null,
      };

      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
          fetchCalls.push({ url, body });

          if (url.endsWith('/api/pairing/status')) {
            return new Response(
              JSON.stringify({
                isLocalDesktop: true,
                authenticated: true,
                sessionStatus: 'desktop',
                activeSession: null,
                pendingRequests: [],
                activeChallenge: null,
                lanUrls: ['http://192.168.1.50:3001'],
              }),
              { status: 200 },
            );
          }
          if (url.endsWith('/api/pairing/challenge')) {
            return new Response(
              JSON.stringify({
                challenge: {
                  challengeId: 'ch-1',
                  pairingCode: 'AbCdEfGh1234',
                  pairingUrl: 'http://192.168.1.50:3001/?pair=AbCdEfGh1234',
                  expiresAt: new Date(Date.now() + 120_000).toISOString(),
                },
                activeSession: null,
                pendingRequests: [],
                activeChallenge: {
                  challengeId: 'ch-1',
                  pairingCode: 'AbCdEfGh1234',
                  pairingUrl: 'http://192.168.1.50:3001/?pair=AbCdEfGh1234',
                  expiresAt: new Date(Date.now() + 120_000).toISOString(),
                },
              }),
              { status: 200 },
            );
          }
          if (url.endsWith('/api/status')) {
            return new Response(JSON.stringify(baseState), { status: 200 });
          }
          if (url.endsWith('/api/presets')) {
            return new Response(
              JSON.stringify({
                presets: SAMPLE_PRESETS,
                directory: null,
                directoryStatus: 'ok',
                warnings: [],
              }),
              { status: 200 },
            );
          }
          if (url.endsWith('/api/presets/reload')) {
            return new Response(
              JSON.stringify({
                presets: SAMPLE_PRESETS,
                directory: null,
                directoryStatus: 'ok',
                warnings: [],
                state: baseState,
              }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({}), { status: 404 });
        }),
      );

      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId('reload-presets-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('reload-presets-btn'));
      await waitFor(() => {
        expect(fetchCalls.some((c) => c.url.endsWith('/api/presets/reload'))).toBe(true);
      });

      fireEvent.click(screen.getByTestId('open-settings-btn'));
      expect(screen.queryByTestId('presets-dir-input')).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('volume-target-option-patch_cc74'),
      ).not.toBeInTheDocument();

      const genQrBtn = await screen.findByTestId('generate-pairing-qr-btn');
      fireEvent.click(genQrBtn);

      await waitFor(() => {
        expect(screen.getByTestId('lan-qr-svg')).toBeInTheDocument();
      });
    });
  });
});
