import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AiGearConfig,
  type AiToneApplyResponse,
  type ControllerState,
  type ExperimentalEditState,
  MG300_EXPERIMENTAL_SLOT,
  type Preset,
  type WsServerMessage,
} from '@quicktone/shared';
import { StageDisplay } from '../components/StageDisplay';
import { SettingsModal } from '../components/SettingsModal';
import { App } from '../App';

const USER_PRESET_1A: Preset = {
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
  isDuplicate: false,
  updatedAt: '2026-11-27T00:00:00.000Z',
  midiMapping: { protocol: 'mg300-cc60', channel: 0, ccNumber: 60, ccValue: 0 },
};

const USER_PRESET_2B: Preset = {
  id: '2B',
  slotIndex: 5,
  bankType: 'user',
  bankNumber: 2,
  patchLetter: 'B',
  displayBank: '2B',
  name: 'Gary Still Blues',
  patchVolume: 60,
  irVolume: 22,
  origin: 'hardware',
  isDuplicate: false,
  updatedAt: '2026-11-27T00:00:00.000Z',
  midiMapping: { protocol: 'mg300-cc60', channel: 0, ccNumber: 60, ccValue: 5 },
};

const FACTORY_PRESET_F1A: Preset = {
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
  updatedAt: '2026-11-27T00:00:00.000Z',
  midiMapping: { protocol: 'mg300-cc60', channel: 0, ccNumber: 60, ccValue: 36 },
};

function buildMockExperimentalState(slot: number, presetName: string): ExperimentalEditState {
  return {
    slot,
    loaded: true,
    busy: false,
    dirty: false,
    sourceMode: 'hardware',
    sourceFileName: null,
    presetName,
    bpm: 118,
    timeFlag: 0,
    ampParams: [62, 10, 58, 52, 60, 56],
    blocksEnabled: [true, true, true, false, true, false, true, true],
    blockModels: { '1': 1, '2': 2, '3': 5, '5': 1, '7': 1, '8': 2, '9': 5, '10': 2 },
    blockParams: {
      '1': [55, 40, 0, 0, 0, 0],
      '2': [45, 55, 60, 0, 0, 0],
      '3': [62, 10, 58, 52, 60, 56],
      '5': [42, 30, 0, 0, 0, 0],
      '7': [48, 30, 28, 0, 0, 0],
      '8': [32, 46, 50, 0, 0, 0],
    },
    cabEnabled: true,
    cabModel: 5,
    micModel: 2,
    irCut: 0,
    irVolume: 22,
    patchVolume: 64,
    hasUserIr: false,
    userIrName: null,
    userIrWarning: null,
    lastSave: null,
  };
}

function buildMockControllerState(overrides: Partial<ControllerState> = {}): ControllerState {
  return {
    connectionState: 'connected',
    connectedPortName: 'NUX NME-300',
    availablePorts: [
      { id: 'port-1', name: 'NUX NME-300', direction: 'duplex', isMg300: true },
    ],
    syncStatus: 'confirmed',
    confirmedState: {
      presetId: '1A',
      slotIndex: 0,
      volume: 60,
      volumeTarget: 'master_cc64',
      confirmedAt: '2026-11-27T00:00:00.000Z',
    },
    lastSentCommand: null,
    volumeTarget: 'master_cc64',
    presetsDirectory: null,
    presetsDirectoryStatus: 'ok',
    includeFactoryPresets: true,
    presetCount: 3,
    warnings: [],
    authRequired: false,
    lastError: null,
    ...overrides,
  };
}

function installFakeWebSocket() {
  const sockets: Array<{
    onmessage: ((event: MessageEvent) => void) | null;
    onopen: (() => void) | null;
    onclose: ((event?: CloseEvent) => void) | null;
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  class FakeWebSocket {
    public onopen: (() => void) | null = null;
    public onmessage: ((event: MessageEvent) => void) | null = null;
    public onerror: (() => void) | null = null;
    public onclose: ((event?: CloseEvent) => void) | null = null;
    public readyState = 1;
    public send = vi.fn();
    public close = vi.fn();

    constructor() {
      sockets.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }
  }

  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  return {
    emit(message: WsServerMessage) {
      for (const s of sockets) {
        s.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
      }
    },
  };
}

describe('AI Tone Assistant UI (StageDisplay, SettingsModal, AiToneModal, App)', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders "Criar timbre com IA" button in StageDisplay for both User and Factory slots', () => {
    const onOpenAiTone = vi.fn();
    const { rerender } = render(
      <StageDisplay
        activePreset={USER_PRESET_1A}
        syncStatus="confirmed"
        confirmedState={{
          presetId: '1A',
          slotIndex: 0,
          volume: 60,
          volumeTarget: 'master_cc64',
          confirmedAt: '2026-11-27T00:00:00.000Z',
        }}
        lastSentCommand={null}
        canOpenEditor
        onEditActiveTone={vi.fn()}
        onCreateNewTone={vi.fn()}
        onOpenAiTone={onOpenAiTone}
      />,
    );

    const userBtn = screen.getByTestId('open-ai-tone-btn');
    expect(userBtn).toHaveTextContent('Criar timbre com IA');
    expect(userBtn.className).toContain('min-h-[44px]');
    expect(screen.getByTestId('open-tone-editor-btn')).toBeInTheDocument();

    rerender(
      <StageDisplay
        activePreset={FACTORY_PRESET_F1A}
        syncStatus="confirmed"
        confirmedState={{
          presetId: 'F1A',
          slotIndex: 36,
          volume: 60,
          volumeTarget: 'master_cc64',
          confirmedAt: '2026-11-27T00:00:00.000Z',
        }}
        lastSentCommand={null}
        canOpenEditor
        onEditActiveTone={vi.fn()}
        onCreateNewTone={vi.fn()}
        onOpenAiTone={onOpenAiTone}
      />,
    );

    expect(screen.queryByTestId('open-tone-editor-btn')).not.toBeInTheDocument();
    const factoryBtn = screen.getByTestId('open-ai-tone-btn');
    expect(factoryBtn).toBeInTheDocument();
    fireEvent.click(factoryBtn);
    expect(onOpenAiTone).toHaveBeenCalledTimes(1);
  });

  it('validates and saves musician gear in SettingsModal on success and preserves inputs on 422 error', async () => {
    const savedGear: AiGearConfig = {
      guitarModel: 'Fender Stratocaster HSS',
      outputTarget: 'Caixa ativa FRFR',
      pickupSummary: 'HSS (humbucker ponte + single braço/meio)',
      recommendations: ['Manter IR ativo com corte leve em graves'],
      updatedAt: '2026-11-27T00:00:00.000Z',
    };

    const onSaveAiGear = vi
      .fn()
      .mockRejectedValueOnce(new Error('O modelo "banana" não foi reconhecido como guitarra.'))
      .mockResolvedValueOnce(savedGear);

    const { rerender } = render(
      <SettingsModal
        isOpen
        availablePorts={[]}
        connectedPortName={null}
        isLocalDesktop={false}
        activeSession={{
          sessionId: 'sess-1',
          deviceName: 'Pixel',
          remoteIp: '192.168.1.30',
          createdAt: '2026-11-27T00:00:00.000Z',
          expiresAt: '2026-11-27T01:00:00.000Z',
          lastActivityAt: '2026-11-27T00:00:00.000Z',
        }}
        pendingRequests={[]}
        activeChallenge={null}
        aiGear={null}
        onClose={vi.fn()}
        onConnectMidiPort={vi.fn()}
        onGeneratePairingQr={vi.fn()}
        onApprovePairing={vi.fn()}
        onRejectPairing={vi.fn()}
        onRevokeMobileSession={vi.fn()}
        onLogoutMobileSession={vi.fn()}
        onSaveAiGear={onSaveAiGear}
      />,
    );

    expect(screen.getByTestId('ai-gear-settings-section')).toBeInTheDocument();

    const guitarInput = screen.getByTestId('ai-gear-guitar-input') as HTMLInputElement;
    const outputInput = screen.getByTestId('ai-gear-output-input') as HTMLInputElement;

    fireEvent.change(guitarInput, { target: { value: 'banana' } });
    fireEvent.change(outputInput, { target: { value: 'Caixa ativa FRFR' } });
    fireEvent.click(screen.getByTestId('ai-gear-save-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-gear-error')).toHaveTextContent(
        'O modelo "banana" não foi reconhecido',
      );
    });
    expect(guitarInput.value).toBe('banana');
    expect(outputInput.value).toBe('Caixa ativa FRFR');

    fireEvent.change(guitarInput, { target: { value: 'Fender Stratocaster HSS' } });
    fireEvent.click(screen.getByTestId('ai-gear-save-btn'));

    await waitFor(() => {
      expect(onSaveAiGear).toHaveBeenCalledWith({
        guitarModel: 'Fender Stratocaster HSS',
        outputTarget: 'Caixa ativa FRFR',
      });
    });

    rerender(
      <SettingsModal
        isOpen
        availablePorts={[]}
        connectedPortName={null}
        isLocalDesktop={false}
        activeSession={null}
        pendingRequests={[]}
        activeChallenge={null}
        aiGear={savedGear}
        onClose={vi.fn()}
        onConnectMidiPort={vi.fn()}
        onGeneratePairingQr={vi.fn()}
        onApprovePairing={vi.fn()}
        onRejectPairing={vi.fn()}
        onRevokeMobileSession={vi.fn()}
        onLogoutMobileSession={vi.fn()}
        onSaveAiGear={onSaveAiGear}
      />,
    );

    const summary = screen.getByTestId('ai-gear-summary');
    expect(summary).toHaveTextContent('HSS (humbucker ponte + single braço/meio)');
    expect(summary).toHaveTextContent('Manter IR ativo com corte leve em graves');
  });

  it('completes full AiToneModal flow in App: Factory default 4D, inline gear preserving prompt/slot, forbidden slot mention guard, cancel confirm preserving state, apply once, and Open in Editor', async () => {
    const ws = installFakeWebSocket();
    let currentGear: AiGearConfig | null = null;
    const applyCalls: Array<{ slotIndex: number; prompt: string }> = [];
    const loadSlotCalls: Array<{ slot?: number }> = [];
    const selectPresetCalls: unknown[] = [];

    const applyResponse: AiToneApplyResponse = {
      slotIndex: 5,
      displayBank: '2B',
      intent: 'create_new',
      presetName: 'Scorpions 80s',
      bpm: 118,
      timeFlag: 0,
      summary: 'Timbre crunch estilo anos 80 com British Plexi e delay curto.',
      tips: ['Use o captador da ponte para maior definição nos riffs.'],
      appliedBlocks: [
        {
          blockCode: 'AMP',
          enabled: true,
          modelName: 'Brit 800',
          params: [
            { label: 'Gain', value: 62 },
            { label: 'Level', value: 58 },
          ],
          changed: true,
        },
        {
          blockCode: 'DLY',
          enabled: true,
          modelName: 'Analog Delay',
          params: [{ label: 'Time', value: 48 }],
          changed: true,
        },
      ],
      calibration: {
        source: 'hardware_user',
        sampleCount: 2,
        avgPatchVolume: 62,
        avgIrVolume: 21,
        avgAmpLevel: 58,
        appliedPatchVolume: 64,
        appliedIrVolume: 22,
        appliedAmpLevel: 58,
      },
      saveResult: {
        targetSlot: 5,
        displayBank: '2B',
        ackReceived: true,
        verified: true,
        mismatchedOffsets: [],
        backupPath: 'backups/2B.json',
        savedAt: '2026-11-27T01:00:00.000Z',
      },
      experimentalState: buildMockExperimentalState(5, 'Scorpions 80s'),
    };

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};

      if (url.endsWith('/api/pairing/status')) {
        return new Response(
          JSON.stringify({
            isLocalDesktop: true,
            authenticated: true,
            sessionStatus: 'desktop',
            activeSession: null,
            pendingRequests: [],
            activeChallenge: null,
            lanUrls: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/status')) {
        return new Response(
          JSON.stringify(
            buildMockControllerState({
              confirmedState: {
                presetId: 'F1A',
                slotIndex: 36,
                volume: 60,
                volumeTarget: 'master_cc64',
                confirmedAt: '2026-11-27T00:00:00.000Z',
              },
            }),
          ),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/presets')) {
        return new Response(
          JSON.stringify({
            presets: [USER_PRESET_1A, USER_PRESET_2B, FACTORY_PRESET_F1A],
            directory: null,
            directoryStatus: 'ok',
            warnings: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/presets/select')) {
        selectPresetCalls.push(body);
        return new Response(
          JSON.stringify({
            state: buildMockControllerState({
              confirmedState: {
                presetId: body.presetId ?? '2B',
                slotIndex: body.slotIndex ?? 5,
                volume: 60,
                volumeTarget: 'master_cc64',
                confirmedAt: '2026-11-27T01:02:00.000Z',
              },
            }),
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/ai/gear') && method === 'GET') {
        return new Response(JSON.stringify({ gear: currentGear }), { status: 200 });
      }
      if (url.endsWith('/api/ai/gear') && method === 'PUT') {
        if (body.guitarModel === 'invalido') {
          return new Response(
            JSON.stringify({
              error: {
                code: 'INVALID_GUITAR_MODEL',
                message: 'Modelo não reconhecido como guitarra.',
                timestamp: '2026-11-27T01:00:00.000Z',
              },
            }),
            { status: 422 },
          );
        }
        currentGear = {
          guitarModel: body.guitarModel,
          outputTarget: body.outputTarget ?? '',
          pickupSummary: 'HH (dois humbuckers)',
          recommendations: ['Corte sutil nos graves abaixo de 90Hz'],
          updatedAt: '2026-11-27T01:00:00.000Z',
        };
        return new Response(JSON.stringify({ gear: currentGear }), { status: 200 });
      }
      if (url.endsWith('/api/ai/tone/apply') && method === 'POST') {
        applyCalls.push(body);
        return new Response(JSON.stringify(applyResponse), { status: 200 });
      }
      if (url.endsWith('/api/experimental/state')) {
        return new Response(
          JSON.stringify(buildMockExperimentalState(0, 'EaglesDF Crunch')),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/experimental/load')) {
        loadSlotCalls.push(body);
        return new Response(
          JSON.stringify(buildMockExperimentalState(body.slot ?? 5, 'Scorpions 80s')),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    vi.stubGlobal('fetch', mockFetch);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('stage-display')).toHaveTextContent('CT 80JM Drive');
    });

    // Factory slot active: open-ai-tone-btn is visible and opens modal with slot 4D (15)
    fireEvent.click(screen.getByTestId('open-ai-tone-btn'));
    const modal = await screen.findByTestId('ai-tone-modal');
    expect(modal).toBeInTheDocument();

    const slotSelect = screen.getByTestId('ai-target-slot-select') as HTMLSelectElement;
    expect(Number(slotSelect.value)).toBe(MG300_EXPERIMENTAL_SLOT);
    expect(slotSelect.options.length).toBe(36);
    expect(slotSelect.textContent).toContain('2B · Gary Still Blues');
    expect(slotSelect.textContent).toContain('4D · Disponível');

    // Global keyboard shortcuts (e.g. '1') must be blocked while AiToneModal is open
    fireEvent.keyDown(window, { key: '1' });
    expect(selectPresetCalls).toHaveLength(0);

    // Choose slot 2B (index 5) and type a prompt BEFORE configuring gear
    fireEvent.change(slotSelect, { target: { value: '5' } });
    const promptInput = screen.getByTestId('ai-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(promptInput, { target: { value: 'Timbre crunch anos 80 no 4C' } });

    // Trying to submit without gear shows error and preserves prompt and slot
    fireEvent.click(screen.getByTestId('ai-submit-btn'));
    expect(screen.getByTestId('ai-validation-error')).toBeInTheDocument();
    expect(promptInput.value).toBe('Timbre crunch anos 80 no 4C');
    expect(Number(slotSelect.value)).toBe(5);

    // Inline gear box: first fail with 422 -> must keep prompt, slot, and inline inputs
    expect(screen.getByTestId('ai-inline-gear-box')).toBeInTheDocument();
    const inlineGuitar = screen.getByTestId('ai-inline-gear-guitar-input') as HTMLInputElement;
    const inlineOutput = screen.getByTestId('ai-inline-gear-output-input') as HTMLInputElement;
    fireEvent.change(inlineGuitar, { target: { value: 'invalido' } });
    fireEvent.change(inlineOutput, { target: { value: 'Fone AKG' } });
    fireEvent.click(screen.getByTestId('ai-inline-gear-save-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-inline-gear-error')).toHaveTextContent(
        'Modelo não reconhecido como guitarra.',
      );
    });
    expect(inlineGuitar.value).toBe('invalido');
    expect(inlineOutput.value).toBe('Fone AKG');
    expect(promptInput.value).toBe('Timbre crunch anos 80 no 4C');
    expect(Number(slotSelect.value)).toBe(5);

    // Now validate real guitar inline -> switches to compact gear summary and preserves prompt/slot
    fireEvent.change(inlineGuitar, { target: { value: 'Gibson Les Paul Standard' } });
    fireEvent.click(screen.getByTestId('ai-inline-gear-save-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-active-gear-summary')).toHaveTextContent(
        'Gibson Les Paul Standard · Fone AKG',
      );
    });
    expect(promptInput.value).toBe('Timbre crunch anos 80 no 4C');
    expect(Number(slotSelect.value)).toBe(5);

    // Forbidden slot mention ("4C") blocks submit while preserving text and slot
    fireEvent.click(screen.getByTestId('ai-submit-btn'));
    expect(screen.getByTestId('ai-validation-error')).toHaveTextContent('4C');
    expect(promptInput.value).toBe('Timbre crunch anos 80 no 4C');
    expect(Number(slotSelect.value)).toBe(5);
    expect(applyCalls).toHaveLength(0);

    // Clean prompt -> opens inline confirmation box
    const cleanPrompt = 'Timbre crunch anos 80 estilo Scorpions com reverb de palco';
    fireEvent.change(promptInput, { target: { value: cleanPrompt } });
    fireEvent.click(screen.getByTestId('ai-submit-btn'));

    const confirmBox = screen.getByTestId('ai-confirm-box');
    expect(confirmBox).toHaveTextContent('2B');
    expect(confirmBox).toHaveTextContent('Gary Still Blues');

    // Cancel closes ONLY confirmation box, keeping prompt and slot
    fireEvent.click(screen.getByTestId('ai-confirm-cancel-btn'));
    expect(screen.queryByTestId('ai-confirm-box')).not.toBeInTheDocument();
    expect(promptInput.value).toBe(cleanPrompt);
    expect(Number(slotSelect.value)).toBe(5);
    expect(applyCalls).toHaveLength(0);

    // Confirm -> calls POST /api/ai/tone/apply directly with no second confirm and displays summary
    fireEvent.click(screen.getByTestId('ai-submit-btn'));
    fireEvent.click(screen.getByTestId('ai-confirm-accept-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-applied-result')).toBeInTheDocument();
    });
    expect(applyCalls).toEqual([{ slotIndex: 5, prompt: cleanPrompt }]);

    const resultBox = screen.getByTestId('ai-applied-result');
    expect(resultBox).toHaveTextContent('Novo timbre');
    expect(resultBox).toHaveTextContent('2B');
    expect(resultBox).toHaveTextContent('Scorpions 80s');
    expect(resultBox).toHaveTextContent('118 BPM');
    expect(resultBox).toHaveTextContent('Brit 800');
    expect(resultBox).toHaveTextContent('Use o captador da ponte');

    // Also verify WebSocket gear_updated keeps gear synced
    act(() => {
      ws.emit({
        type: 'gear_updated',
        gear: {
          guitarModel: 'PRS Custom 24',
          outputTarget: 'FRFR Headrush',
          pickupSummary: 'HH (humbuckers)',
          recommendations: [],
          updatedAt: '2026-11-27T01:05:00.000Z',
        },
        timestamp: '2026-11-27T01:05:00.000Z',
      });
    });
    expect(screen.getByTestId('ai-active-gear-summary')).toHaveTextContent(
      'PRS Custom 24 · FRFR Headrush',
    );

    // Click "Abrir no Editor" -> closes AiToneModal, opens ToneEditorDrawer and loads slot 5
    fireEvent.click(screen.getByTestId('ai-open-in-editor-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('ai-tone-modal')).not.toBeInTheDocument();
      expect(screen.getByTestId('experimental-edit-panel')).toBeInTheDocument();
    });
    expect(loadSlotCalls).toContainEqual({ slot: 5 });

    // Close drawer and select slot 2B in PresetGrid to verify signalChain LEDs are NOT shifted
    fireEvent.click(screen.getByTestId('close-tone-editor-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('experimental-edit-panel')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('preset-card-2B'));
    await waitFor(() => {
      expect(screen.getByTestId('stage-display')).toHaveTextContent('Scorpions 80s');
    });
    const strip = screen.getByTestId('signal-chain-strip');
    expect(strip.querySelector('[data-block="COMP"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="EFX"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="AMP"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="EQ"]')?.getAttribute('data-active')).toBe('false');
    expect(strip.querySelector('[data-block="NR"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="MOD"]')?.getAttribute('data-active')).toBe('false');
    expect(strip.querySelector('[data-block="DLY"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="RVB"]')?.getAttribute('data-active')).toBe('true');
    expect(strip.querySelector('[data-block="CAB"]')?.getAttribute('data-active')).toBe('true');
  });

  it('shows unverified warning in AiToneModal and avoids optimistic library update when saveResult.verified is false', async () => {
    installFakeWebSocket();

    const unverifiedResponse: AiToneApplyResponse = {
      slotIndex: 5,
      displayBank: '2B',
      intent: 'edit_existing',
      presetName: 'Unverified Tone',
      bpm: 120,
      timeFlag: 0,
      summary: 'Tentativa de gravação sem confirmação de readback.',
      tips: [],
      appliedBlocks: [],
      calibration: {
        source: 'hardware_user',
        sampleCount: 1,
        avgPatchVolume: 60,
        avgIrVolume: 20,
        avgAmpLevel: 50,
        appliedPatchVolume: 60,
        appliedIrVolume: 20,
        appliedAmpLevel: 50,
      },
      saveResult: {
        targetSlot: 5,
        displayBank: '2B',
        ackReceived: false,
        verified: false,
        mismatchedOffsets: [10],
        backupPath: 'backups/2B.json',
        savedAt: '2026-11-27T01:00:00.000Z',
      },
      experimentalState: buildMockExperimentalState(5, 'Unverified Tone'),
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.endsWith('/api/pairing/status')) {
          return new Response(
            JSON.stringify({
              isLocalDesktop: true,
              authenticated: true,
              sessionStatus: 'desktop',
              activeSession: null,
              pendingRequests: [],
              activeChallenge: null,
              lanUrls: [],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/status')) {
          return new Response(
            JSON.stringify(
              buildMockControllerState({
                confirmedState: {
                  presetId: '2B',
                  slotIndex: 5,
                  volume: 60,
                  volumeTarget: 'master_cc64',
                  confirmedAt: '2026-11-27T00:00:00.000Z',
                },
              }),
            ),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/presets')) {
          return new Response(
            JSON.stringify({
              presets: [USER_PRESET_1A, USER_PRESET_2B],
              directory: null,
              directoryStatus: 'ok',
              warnings: [],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/ai/gear') && method === 'GET') {
          return new Response(
            JSON.stringify({
              gear: {
                guitarModel: 'Fender Telecaster',
                outputTarget: 'FRFR',
                pickupSummary: 'SS',
                recommendations: [],
                updatedAt: '2026-11-27T00:00:00.000Z',
              },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/ai/tone/apply') && method === 'POST') {
          return new Response(JSON.stringify(unverifiedResponse), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }),
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('stage-display')).toHaveTextContent('Gary Still Blues');
    });

    fireEvent.click(screen.getByTestId('open-ai-tone-btn'));
    await screen.findByTestId('ai-tone-modal');

    fireEvent.change(screen.getByTestId('ai-prompt-input'), {
      target: { value: 'Mais brilho no clean' },
    });
    fireEvent.click(screen.getByTestId('ai-submit-btn'));
    fireEvent.click(screen.getByTestId('ai-confirm-accept-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-applied-result')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-save-unverified-warning')).toHaveTextContent(
      '1 diferença(s) detectada(s)',
    );
    expect(screen.getByTestId('ai-applied-result')).toHaveTextContent('Verificação pendente');

    fireEvent.click(screen.getByTestId('ai-close-result-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('ai-tone-modal')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('stage-display')).toHaveTextContent('Gary Still Blues');
    expect(screen.getByTestId('preset-card-2B')).toHaveTextContent('Gary Still Blues');
  });

  it('shows midi disconnected banner in AiToneModal and blocks AI submission without losing prompt/slot', async () => {
    installFakeWebSocket();
    const applyCalls: unknown[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.endsWith('/api/pairing/status')) {
          return new Response(
            JSON.stringify({
              isLocalDesktop: true,
              authenticated: true,
              sessionStatus: 'desktop',
              activeSession: null,
              pendingRequests: [],
              activeChallenge: null,
              lanUrls: [],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/status')) {
          return new Response(
            JSON.stringify(
              buildMockControllerState({
                connectionState: 'disconnected',
                connectedPortName: null,
              }),
            ),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/presets')) {
          return new Response(
            JSON.stringify({
              presets: [USER_PRESET_1A, USER_PRESET_2B],
              directory: null,
              directoryStatus: 'ok',
              warnings: [],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/ai/gear') && method === 'GET') {
          return new Response(
            JSON.stringify({
              gear: {
                guitarModel: 'Ibanez RG550',
                outputTarget: 'FRFR',
                pickupSummary: 'HSH',
                recommendations: [],
                updatedAt: '2026-11-27T00:00:00.000Z',
              },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/ai/tone/apply')) {
          applyCalls.push(init?.body);
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }),
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('open-ai-tone-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-ai-tone-btn'));
    const modal = await screen.findByTestId('ai-tone-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId('ai-midi-disconnected-banner')).toBeInTheDocument();

    const slotSelect = screen.getByTestId('ai-target-slot-select') as HTMLSelectElement;
    fireEvent.change(slotSelect, { target: { value: '5' } });
    const promptInput = screen.getByTestId('ai-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(promptInput, { target: { value: 'Lead moderno com delay' } });

    const submitBtn = screen.getByTestId('ai-submit-btn');
    expect(submitBtn).toBeDisabled();
    fireEvent.click(submitBtn);

    expect(applyCalls).toHaveLength(0);
    expect(promptInput.value).toBe('Lead moderno com delay');
    expect(Number(slotSelect.value)).toBe(5);
  });
});
