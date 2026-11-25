import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  ControllerStateSchema,
  HealthResponseSchema,
  MG300_MIDI_CC,
  PresetsResponseSchema,
  type WsServerMessage,
  WsServerMessageSchema,
} from '@quicktone/shared';
import { buildNuxPresetBinary } from '@quicktone/reader';
import { MockMidiAdapter } from '@quicktone/midi';
import {
  createBackendApp,
  isAllowedLanOrigin,
  startBackendServer,
  type QuickToneBackendApp,
} from '../index.js';

interface TestWsClient {
  ws: WebSocket;
  messages: WsServerMessage[];
  waitForMessage: (
    predicate: (msg: WsServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<WsServerMessage>;
  close: () => Promise<void>;
}

async function connectTestWsClient(
  url: string,
  headers?: Record<string, string>,
): Promise<TestWsClient> {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  const messages: WsServerMessage[] = [];
  const waiters = new Set<{
    predicate: (msg: WsServerMessage) => boolean;
    resolve: (msg: WsServerMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  ws.on('message', (rawData) => {
    const text = Buffer.isBuffer(rawData)
      ? rawData.toString('utf8')
      : Array.isArray(rawData)
        ? Buffer.concat(rawData).toString('utf8')
        : Buffer.from(rawData as ArrayBuffer).toString('utf8');
    const parsed = WsServerMessageSchema.parse(JSON.parse(text));
    messages.push(parsed);

    for (const waiter of waiters) {
      if (waiter.predicate(parsed)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(parsed);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });

  const waitForMessage = (
    predicate: (msg: WsServerMessage) => boolean,
    timeoutMs = 3000,
  ): Promise<WsServerMessage> => {
    const existing = messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<WsServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        for (const w of waiters) {
          if (w.timer === timer) {
            waiters.delete(w);
          }
        }
        reject(new Error(`Timeout waiting for WebSocket message after ${timeoutMs}ms`));
      }, timeoutMs);

      waiters.add({ predicate, resolve, reject, timer });
    });
  };

  const close = async (): Promise<void> => {
    for (const w of waiters) {
      clearTimeout(w.timer);
    }
    waiters.clear();
    if (ws.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  };

  return { ws, messages, waitForMessage, close };
}

describe('@quicktone/backend — Unit & Contract Tests (Section 7)', () => {
  let tempDir: string;
  let mockAdapter: MockMidiAdapter;
  let app: QuickToneBackendApp;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'quicktone-backend-test-'));

    const preset1A = buildNuxPresetBinary({
      name: 'EaglesDF Crunch',
      patchVolume: 64,
      slotIndex: 0,
      formatVersion: 'v2',
    });
    const preset1B = buildNuxPresetBinary({
      name: 'SCORPIONS',
      patchVolume: 72,
      slotIndex: 1,
      formatVersion: 'v2',
    });

    await fs.promises.writeFile(
      path.join(tempDir, '01_EaglesDF Crunch.nuxpreset'),
      preset1A,
    );
    await fs.promises.writeFile(path.join(tempDir, '02_SCORPIONS.nuxpreset'), preset1B);

    mockAdapter = new MockMidiAdapter({
      autoConfirmHardware: false,
    });

    app = createBackendApp({
      midiAdapter: mockAdapter,
      presetsDirectory: tempDir,
      includeFactoryPresets: false,
      staticDir: null,
    });
  });

  afterEach(async () => {
    await app.close();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('1. REST API Endpoints', () => {
    it('GET /api/health returns valid HealthResponse', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(response.statusCode).toBe(200);
      const body = HealthResponseSchema.parse(response.json());
      expect(body.status).toBe('ok');
      expect(body.service).toBe('quicktone-web-controller');
      expect(body.midiConnection).toBe('disconnected');
      expect(body.syncStatus).toBe('unknown');
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('GET /api/presets returns discovered presets from configured folder', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/presets',
      });

      expect(response.statusCode).toBe(200);
      const body = PresetsResponseSchema.parse(response.json());
      expect(body.directory).toBe(tempDir);
      expect(body.directoryStatus).toBe('ok');
      expect(body.presets).toHaveLength(2);
      expect(body.presets[0]?.id).toBe('1A');
      expect(body.presets[0]?.name).toBe('EaglesDF Crunch');
      expect(body.presets[0]?.patchVolume).toBe(64);
      expect(body.presets[1]?.id).toBe('1B');
      expect(body.presets[1]?.name).toBe('SCORPIONS');
      expect(body.presets[1]?.patchVolume).toBe(72);
    });

    it('GET /api/status returns complete ControllerState snapshot', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/status',
      });

      expect(response.statusCode).toBe(200);
      const state = ControllerStateSchema.parse(response.json());
      expect(state.connectionState).toBe('disconnected');
      expect(state.connectedPortName).toBeNull();
      expect(state.availablePorts).toHaveLength(1);
      expect(state.availablePorts[0]?.name).toBe('NUX NME-300');
      expect(state.syncStatus).toBe('unknown');
      expect(state.presetsDirectory).toBe(tempDir);
      expect(state.presetsDirectoryStatus).toBe('ok');
      expect(state.presetCount).toBe(2);
      expect(state.authRequired).toBe(false);
    });

    it('POST /api/midi/connect and POST /api/midi/disconnect manage MIDI connection lifecycle', async () => {
      const connectRes = await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        payload: {},
      });

      expect(connectRes.statusCode).toBe(200);
      const connectedBody = connectRes.json() as { state: unknown };
      const connectedState = ControllerStateSchema.parse(connectedBody.state);
      expect(connectedState.connectionState).toBe('connected');
      expect(connectedState.connectedPortName).toBe('NUX NME-300');

      const disconnectRes = await app.inject({
        method: 'POST',
        url: '/api/midi/disconnect',
      });

      expect(disconnectRes.statusCode).toBe(200);
      const disconnectedBody = disconnectRes.json() as { state: unknown };
      const disconnectedState = ControllerStateSchema.parse(disconnectedBody.state);
      expect(disconnectedState.connectionState).toBe('disconnected');
      expect(disconnectedState.connectedPortName).toBeNull();
    });

    it('POST /api/presets/select selects preset by presetId or slotIndex and sends CC 0x3C', async () => {
      await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });

      const selectByIdRes = await app.inject({
        method: 'POST',
        url: '/api/presets/select',
        payload: { presetId: '1B' },
      });

      expect(selectByIdRes.statusCode).toBe(200);
      const byIdBody = selectByIdRes.json();
      const byIdState = ControllerStateSchema.parse(byIdBody.state);
      expect(byIdState.syncStatus).toBe('command_sent_unconfirmed');
      expect(byIdState.lastSentCommand?.presetId).toBe('1B');
      expect(byIdState.lastSentCommand?.slotIndex).toBe(1);
      expect(byIdState.lastSentCommand?.midiBytes).toEqual([
        0xb0,
        MG300_MIDI_CC.PRESET_SELECT,
        1,
      ]);
      expect(byIdState.lastSentCommand?.confirmedByDevice).toBe(false);

      const selectBySlotRes = await app.inject({
        method: 'POST',
        url: '/api/presets/select',
        payload: { slotIndex: 36 }, // Factory F1A
      });

      expect(selectBySlotRes.statusCode).toBe(200);
      const bySlotBody = selectBySlotRes.json();
      const bySlotState = ControllerStateSchema.parse(bySlotBody.state);
      expect(bySlotState.lastSentCommand?.presetId).toBe('F1A');
      expect(bySlotState.lastSentCommand?.slotIndex).toBe(36);
      expect(bySlotState.lastSentCommand?.midiBytes).toEqual([
        0xb0,
        MG300_MIDI_CC.PRESET_SELECT,
        36,
      ]);
    });

    it('PUT /api/volume sends Master Volume CC 0x40 and rejects non-Master targets', async () => {
      await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });

      const masterRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: 85, target: 'master_cc64' },
      });
      expect(masterRes.statusCode).toBe(200);
      const masterState = ControllerStateSchema.parse(masterRes.json().state);
      expect(masterState.lastSentCommand?.midiBytes).toEqual([
        0xb0,
        MG300_MIDI_CC.MASTER_VOLUME,
        85,
      ]);

      const patchRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: 60, target: 'patch_cc74' },
      });
      expect(patchRes.statusCode).toBe(400);
      expect(patchRes.json().code).toBe('VALIDATION_ERROR');

      const exprRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: 60, target: 'expression_cc61' },
      });
      expect(exprRes.statusCode).toBe(400);
      expect(exprRes.json().code).toBe('VALIDATION_ERROR');
    });

    it('POST /api/presets/config updates presets directory and supports factory presets toggle', async () => {
      const secondDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'quicktone-backend-dir2-'),
      );
      try {
        const customPreset = buildNuxPresetBinary({
          name: 'Custom Lead 3C',
          patchVolume: 90,
          slotIndex: 10,
          formatVersion: 'v2',
        });
        await fs.promises.writeFile(
          path.join(secondDir, 'CustomLead.nuxpreset'),
          customPreset,
        );

        const configRes = await app.inject({
          method: 'POST',
          url: '/api/presets/config',
          payload: {
            directoryPath: secondDir,
            includeFactoryPresets: true,
          },
        });

        expect(configRes.statusCode).toBe(200);
        const parsed = PresetsResponseSchema.parse(configRes.json());
        expect(parsed.directory).toBe(secondDir);
        expect(parsed.directoryStatus).toBe('ok');
        // 1 user preset + 36 factory presets = 37
        expect(parsed.presets).toHaveLength(37);
        expect(parsed.presets[0]?.name).toBe('Custom Lead 3C');
        expect(parsed.presets[0]?.id).toBe('3C');

        // Toggle includeFactoryPresets without directoryPath
        const toggleOffRes = await app.inject({
          method: 'POST',
          url: '/api/presets/config',
          payload: { includeFactoryPresets: false },
        });
        expect(toggleOffRes.statusCode).toBe(200);
        expect(PresetsResponseSchema.parse(toggleOffRes.json()).presets).toHaveLength(1);
        expect(toggleOffRes.json().state.includeFactoryPresets).toBe(false);
      } finally {
        await fs.promises.rm(secondDir, { recursive: true, force: true });
      }
    });

    it('POST /api/presets/reload reloads disk presets and triggers SysEx sync when connected', async () => {
      const sysExAdapter = new MockMidiAdapter({ autoConfirmHardware: false });
      const sysExApp = createBackendApp({
        midiAdapter: sysExAdapter,
        presetsDirectory: tempDir,
        includeFactoryPresets: false,
        enableSysExSync: true,
        staticDir: null,
      });

      try {
        await sysExApp.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
        await new Promise((resolve) => setTimeout(resolve, 150));
        sysExAdapter.clearSentMessages();

        const reloadRes = await sysExApp.inject({
          method: 'POST',
          url: '/api/presets/reload',
          payload: {},
        });
        expect(reloadRes.statusCode).toBe(200);
        const body = reloadRes.json();
        expect(PresetsResponseSchema.parse(body).presets).toHaveLength(2);
        expect(ControllerStateSchema.parse(body.state).presetCount).toBe(2);

        await new Promise((resolve) => setTimeout(resolve, 160));
        const sent = sysExAdapter.getSentMessages();
        expect(sent.some((m) => m[0] === 0xf0 && m[6] === 0x00)).toBe(true);
        expect(sent.some((m) => m[0] === 0xf0 && m[7] === 0x19)).toBe(true);
      } finally {
        await sysExApp.close();
      }
    });
  });

  describe('2. Payload Validation & Non-Existent Presets', () => {
    it('returns 400 VALIDATION_ERROR on invalid preset selection payload', async () => {
      const emptyRes = await app.inject({
        method: 'POST',
        url: '/api/presets/select',
        payload: {},
      });
      expect(emptyRes.statusCode).toBe(400);
      expect(emptyRes.json().code).toBe('VALIDATION_ERROR');

      const outOfRangeRes = await app.inject({
        method: 'POST',
        url: '/api/presets/select',
        payload: { slotIndex: 99 },
      });
      expect(outOfRangeRes.statusCode).toBe(400);
      expect(outOfRangeRes.json().code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 PRESET_NOT_FOUND when selecting an unknown presetId', async () => {
      await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });

      const notFoundRes = await app.inject({
        method: 'POST',
        url: '/api/presets/select',
        payload: { presetId: 'NON_EXISTENT_PRESET' },
      });

      expect(notFoundRes.statusCode).toBe(404);
      expect(notFoundRes.json().code).toBe('PRESET_NOT_FOUND');
    });

    it('returns 400 VALIDATION_ERROR on out-of-range volume or invalid target', async () => {
      const highVolRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: 101 },
      });
      expect(highVolRes.statusCode).toBe(400);
      expect(highVolRes.json().code).toBe('VALIDATION_ERROR');

      const negativeVolRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: -1 },
      });
      expect(negativeVolRes.statusCode).toBe(400);
      expect(negativeVolRes.json().code).toBe('VALIDATION_ERROR');

      const invalidTargetRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: 50, target: 'invalid_cc7' },
      });
      expect(invalidTargetRes.statusCode).toBe(400);
      expect(invalidTargetRes.json().code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR on empty directoryPath in POST /api/presets/config', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/presets/config',
        payload: { directoryPath: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });
  });

  describe('3. MIDI Error Handling (404, 409, 503)', () => {
    it('returns 404 DEVICE_NOT_FOUND when requested MIDI port does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        payload: { portName: 'Unknown MIDI Port' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DEVICE_NOT_FOUND');
    });

    it('returns 409 PORT_BUSY when NUX NME-300 port is locked by another process', async () => {
      mockAdapter.setPortBusy('NUX NME-300', true);

      const res = await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        payload: { portName: 'NUX NME-300' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('PORT_BUSY');
    });

    it('returns 503 DISCONNECTED when sending commands without active MIDI connection', async () => {
      const presetRes = await app.inject({
        method: 'POST',
        url: '/api/presets/select',
        payload: { presetId: '1A' },
      });
      expect(presetRes.statusCode).toBe(503);
      expect(presetRes.json().code).toBe('DISCONNECTED');

      const volumeRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: 50 },
      });
      expect(volumeRes.statusCode).toBe(503);
      expect(volumeRes.json().code).toBe('DISCONNECTED');
    });

    it('returns 503 TRANSMISSION_FAILED when MIDI adapter fails to transmit bytes', async () => {
      await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
      mockAdapter.setFailOnSend(true);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: 50 },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('TRANSMISSION_FAILED');
    });
  });

  describe('4. Tri-State Synchronization (Unconfirmed Sent Command vs Hardware Confirmed)', () => {
    it('distinguishes command_sent_unconfirmed from confirmed hardware state via MIDI IN', async () => {
      await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });

      // Step 1: Send preset change -> unconfirmed
      const selectRes = await app.inject({
        method: 'POST',
        url: '/api/presets/select',
        payload: { presetId: '1B' },
      });
      expect(selectRes.statusCode).toBe(200);
      const unconfirmedState = ControllerStateSchema.parse(selectRes.json().state);
      expect(unconfirmedState.syncStatus).toBe('command_sent_unconfirmed');
      expect(unconfirmedState.lastSentCommand?.confirmedByDevice).toBe(false);
      expect(unconfirmedState.confirmedState.presetId).toBeNull();
      expect(unconfirmedState.confirmedState.slotIndex).toBeNull();

      // Step 2: Hardware confirms slot 1 (1B) via MIDI IN CC 0x3C = 1
      mockAdapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.PRESET_SELECT, 1]);

      const statusAfterPresetIn = await app.inject({
        method: 'GET',
        url: '/api/status',
      });
      const confirmedPresetState = ControllerStateSchema.parse(
        statusAfterPresetIn.json(),
      );
      expect(confirmedPresetState.syncStatus).toBe('confirmed');
      expect(confirmedPresetState.lastSentCommand?.confirmedByDevice).toBe(true);
      expect(confirmedPresetState.confirmedState.presetId).toBe('1B');
      expect(confirmedPresetState.confirmedState.slotIndex).toBe(1);
      expect(confirmedPresetState.confirmedState.confirmedAt).not.toBeNull();

      // Step 3: Send volume change -> transitions back to command_sent_unconfirmed until hardware confirms
      const volRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: 77, target: 'master_cc64' },
      });
      const unconfirmedVolState = ControllerStateSchema.parse(volRes.json().state);
      expect(unconfirmedVolState.syncStatus).toBe('command_sent_unconfirmed');
      expect(unconfirmedVolState.lastSentCommand?.confirmedByDevice).toBe(false);
      expect(unconfirmedVolState.confirmedState.volume).toBeNull();

      // Step 4: Hardware confirms master volume 77 via MIDI IN CC 0x40 = 77
      mockAdapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.MASTER_VOLUME, 77]);

      const statusAfterVolIn = await app.inject({
        method: 'GET',
        url: '/api/status',
      });
      const confirmedVolState = ControllerStateSchema.parse(statusAfterVolIn.json());
      expect(confirmedVolState.syncStatus).toBe('confirmed');
      expect(confirmedVolState.lastSentCommand?.confirmedByDevice).toBe(true);
      expect(confirmedVolState.confirmedState.volume).toBe(77);
      expect(confirmedVolState.confirmedState.volumeTarget).toBe('master_cc64');
    });
  });

  describe('5. LAN Origin Security & Configurable Token/PIN Authentication (Section 9)', () => {
    it('validates LAN origins vs external untrusted origins', async () => {
      expect(isAllowedLanOrigin('http://localhost:5173')).toBe(true);
      expect(isAllowedLanOrigin('http://127.0.0.1:3001')).toBe(true);
      expect(isAllowedLanOrigin('http://[::1]:3001')).toBe(true);
      expect(isAllowedLanOrigin('http://192.168.1.25:5173')).toBe(true);
      expect(isAllowedLanOrigin('http://10.0.0.12:3001')).toBe(true);
      expect(isAllowedLanOrigin('http://172.16.5.4:3001')).toBe(true);
      expect(isAllowedLanOrigin('http://172.31.255.254:3001')).toBe(true);

      expect(isAllowedLanOrigin('https://evil.example.com')).toBe(false);
      expect(isAllowedLanOrigin('http://8.8.8.8:3001')).toBe(false);
      expect(isAllowedLanOrigin('http://172.32.0.1:3001')).toBe(false);

      // Control request from external origin is blocked with 403
      const forbiddenRes = await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        headers: {
          origin: 'https://evil.example.com',
        },
        payload: {},
      });
      expect(forbiddenRes.statusCode).toBe(403);
      expect(forbiddenRes.json().code).toBe('FORBIDDEN_ORIGIN');

      // Unpaired control request from LAN IP receives LAN CORS header and requires QR pairing (401)
      const allowedLanRes = await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        headers: {
          origin: 'http://192.168.0.105:5173',
        },
        payload: {},
      });
      expect(allowedLanRes.statusCode).toBe(401);
      expect(allowedLanRes.json().code).toBe('PAIRING_REQUIRED');
      expect(allowedLanRes.headers['access-control-allow-origin']).toBe(
        'http://192.168.0.105:5173',
      );

      // Same-origin local desktop request succeeds (200)
      const localDesktopRes = await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        headers: {
          origin: 'http://localhost:5173',
        },
        payload: {},
      });
      expect(localDesktopRes.statusCode).toBe(200);
      expect(localDesktopRes.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );
    });

    it('enforces token/PIN authentication on control routes when authToken is configured', async () => {
      app.stateManager.setAuthToken('2580');

      const statusRes = await app.inject({
        method: 'GET',
        url: '/api/status',
      });
      expect(statusRes.statusCode).toBe(200);
      const unauthStatus = ControllerStateSchema.parse(statusRes.json());
      expect(unauthStatus.authRequired).toBe(true);
      expect(unauthStatus.presetsDirectory).toBeNull();
      expect(unauthStatus.lanUrls).toEqual([]);

      const unauthPresetsRes = await app.inject({
        method: 'GET',
        url: '/api/presets?refresh=true',
      });
      expect(unauthPresetsRes.statusCode).toBe(200);
      expect(PresetsResponseSchema.parse(unauthPresetsRes.json()).presets).toHaveLength(0);

      // Authenticated GET returns full presets & directory
      const authStatusRes = await app.inject({
        method: 'GET',
        url: '/api/status',
        headers: { 'x-quicktone-token': '2580' },
      });
      expect(ControllerStateSchema.parse(authStatusRes.json()).presetsDirectory).toBe(tempDir);

      // Null byte static path returns 400 BAD_REQUEST instead of 500
      const nullByteRes = await app.inject({
        method: 'GET',
        url: '/%00',
      });
      expect([400, 404]).toContain(nullByteRes.statusCode);

      // Missing token -> 401
      const noTokenRes = await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        payload: {},
      });
      expect(noTokenRes.statusCode).toBe(401);
      expect(noTokenRes.json().code).toBe('UNAUTHORIZED');

      // Wrong token -> 401
      const wrongTokenRes = await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        headers: {
          'x-quicktone-token': '0000',
        },
        payload: {},
      });
      expect(wrongTokenRes.statusCode).toBe(401);
      expect(wrongTokenRes.json().code).toBe('UNAUTHORIZED');

      // Correct token via X-QuickTone-Token -> 200
      const validHeaderRes = await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        headers: {
          'x-quicktone-token': '2580',
        },
        payload: {},
      });
      expect(validHeaderRes.statusCode).toBe(200);

      // Correct token via Authorization: Bearer -> 200
      const validBearerRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        headers: {
          authorization: 'Bearer 2580',
        },
        payload: { volume: 65 },
      });
      expect(validBearerRes.statusCode).toBe(200);
    });
  });

  describe('6. WebSocket Protocol (initial state_sync, ping/pong, request_sync)', () => {
    it('delivers initial state_sync on connection and responds to ping and request_sync', async () => {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const client = await connectTestWsClient(`ws://127.0.0.1:${port}/ws`);
      try {
        const initialSync = await client.waitForMessage((m) => m.type === 'state_sync');
        expect(initialSync.type).toBe('state_sync');
        if (initialSync.type === 'state_sync') {
          expect(initialSync.state.presetCount).toBe(2);
          expect(initialSync.presets).toHaveLength(2);
        }

        client.ws.send(JSON.stringify({ type: 'ping' }));
        const pongMsg = await client.waitForMessage((m) => m.type === 'pong');
        expect(pongMsg.type).toBe('pong');

        client.messages.length = 0;
        client.ws.send(JSON.stringify({ type: 'request_sync' }));
        const requestedSync = await client.waitForMessage((m) => m.type === 'state_sync');
        expect(requestedSync.type).toBe('state_sync');
      } finally {
        await client.close();
      }
    });

    it('rejects non-Master POST /api/volume/target and merges live hardware SysEx preset dumps', async () => {
      const targetRes = await app.inject({
        method: 'POST',
        url: '/api/volume/target',
        payload: { target: 'patch_cc74' },
      });
      expect(targetRes.statusCode).toBe(400);

      const masterTargetRes = await app.inject({
        method: 'POST',
        url: '/api/volume/target',
        payload: { target: 'master_cc64' },
      });
      expect(masterTargetRes.statusCode).toBe(200);
      expect(masterTargetRes.json().state.volumeTarget).toBe('master_cc64');

      // Connect and simulate incoming 113B SysEx preset dump for slot 2 (1C)
      await app.inject({
        method: 'POST',
        url: '/api/midi/connect',
        payload: {},
      });

      const dump = new Array<number>(113).fill(0);
      dump[0] = 0xf0;
      dump[1] = 0x00;
      dump[2] = 0x11;
      dump[3] = 0x22;
      dump[4] = 0x66;
      dump[5] = 0x00;
      dump[6] = 0x70;
      dump[7] = 0x06;
      dump[8] = 2; // 1C
      dump[9 + 0x03] = 5; // AMP active
      dump[9 + 0x44] = 4; // name length
      dump[9 + 0x45] = 11; // L
      dump[9 + 0x46] = 8; // I
      dump[9 + 0x47] = 21; // V
      dump[9 + 0x48] = 4; // E
      dump[111] = 77;
      dump[112] = 0xf7;
      mockAdapter.simulateHardwareIncoming(dump);

      // Wait past 45ms hardware dump coalesce window
      await new Promise((resolve) => setTimeout(resolve, 90));

      const presetsRes = await app.inject({
        method: 'GET',
        url: '/api/presets',
      });
      expect(presetsRes.statusCode).toBe(200);
      const parsed = PresetsResponseSchema.parse(presetsRes.json());
      const slot1C = parsed.presets.find((p) => p.id === '1C');
      expect(slot1C?.name).toBe('LIVE');
      expect(slot1C?.origin).toBe('hardware');
      expect(slot1C?.patchVolume).toBe(77);
      expect(slot1C?.signalChain?.ampEnabled).toBe(true);
    });

    it('rejects unauthenticated /ws upgrade with 401 when authToken is enabled and omits placeholder presets in startBackendServer', async () => {
      app.stateManager.setAuthToken('2580');
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      // Unauthenticated WS attempt must fail upgrade (401)
      await expect(connectTestWsClient(`ws://127.0.0.1:${port}/ws`)).rejects.toThrow();

      // Authenticated WS attempt succeeds
      const authedClient = await connectTestWsClient(
        `ws://127.0.0.1:${port}/ws?token=2580`,
      );
      const syncMsg = await authedClient.waitForMessage((m) => m.type === 'state_sync');
      expect(syncMsg.type).toBe('state_sync');
      await authedClient.close();

      // Verify startBackendServer disables placeholder user slots by default (2 disk + 36 factory = 38, zero placeholders)
      const started = await startBackendServer({
        host: '127.0.0.1',
        port: 0,
        midiAdapter: new MockMidiAdapter(),
        presetsDirectory: tempDir,
        staticDir: null,
      });
      try {
        const res = await started.app.inject({ method: 'GET', url: '/api/presets' });
        expect(res.statusCode).toBe(200);
        const body = PresetsResponseSchema.parse(res.json());
        expect(body.presets).toHaveLength(38);
        expect(body.presets.some((p) => p.origin === 'placeholder')).toBe(false);
        const st = ControllerStateSchema.parse(
          (await started.app.inject({ method: 'GET', url: '/api/status' })).json(),
        );
        expect(st.lanUrls).toBeDefined();
      } finally {
        await started.app.close();
      }
    });
  });

  describe('7. Mandatory QR Pairing, Single Mobile Controller Limit & DNS Rebinding Protection', () => {
    it('blocks remote unauthenticated access, requires desktop approval, enforces single mobile controller, supports revocation/expiration/rate-limit, and blocks DNS rebinding', async () => {
      const pairingApp = createBackendApp({
        midiAdapter: mockAdapter,
        presetsDirectory: tempDir,
        includeFactoryPresets: true,
        staticDir: null,
        pairingOptions: {
          rateLimitMaxAttempts: 3,
          rateLimitWindowMs: 30_000,
          sessionTtlMs: 2000,
        },
      });
      await pairingApp.listen({ host: '127.0.0.1', port: 0 });
      const addr = pairingApp.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const remoteHeaders = {
          'x-forwarded-for': '192.168.1.50',
          origin: 'http://192.168.1.50:3001',
        };

        // 1. DNS Rebinding protection: external Host rejected on HTTP and WS
        const rebindRes = await pairingApp.inject({
          method: 'GET',
          url: '/api/health',
          headers: { host: 'evil.attacker.com:3001' },
        });
        expect(rebindRes.statusCode).toBe(403);
        expect(rebindRes.json().code).toBe('FORBIDDEN_HOST');

        await expect(
          connectTestWsClient(`ws://127.0.0.1:${port}/ws`, {
            Host: 'evil.attacker.com:3001',
          }),
        ).rejects.toThrow();

        // 2. Remote phone without pairing session is blocked on HTTP & WS
        const unauthRemoteStatus = await pairingApp.inject({
          method: 'GET',
          url: '/api/status',
          headers: remoteHeaders,
        });
        expect(unauthRemoteStatus.statusCode).toBe(401);
        expect(unauthRemoteStatus.json().code).toBe('PAIRING_REQUIRED');

        const unauthRemoteSelect = await pairingApp.inject({
          method: 'POST',
          url: '/api/presets/select',
          headers: remoteHeaders,
          payload: { presetId: '1A' },
        });
        expect(unauthRemoteSelect.statusCode).toBe(401);

        await expect(
          connectTestWsClient(`ws://127.0.0.1:${port}/ws`, {
            Origin: 'http://192.168.1.50:3001',
          }),
        ).rejects.toThrow();

        // 3. Rate limiting on invalid pairing attempts
        for (let i = 0; i < 3; i++) {
          const badPair = await pairingApp.inject({
            method: 'POST',
            url: '/api/pairing/request',
            headers: remoteHeaders,
            payload: { pairingCode: 'INVALID_CODE_XYZ', deviceName: 'Attacker' },
          });
          expect(badPair.statusCode).toBe(401);
        }
        const rateLimited = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/request',
          headers: remoteHeaders,
          payload: { pairingCode: 'INVALID_CODE_XYZ', deviceName: 'Attacker' },
        });
        expect(rateLimited.statusCode).toBe(429);
        expect(rateLimited.json().code).toBe('RATE_LIMITED');

        // 4. Desktop generates temporary QR challenge; Mobile A requests pairing
        const phoneAHeaders = {
          'x-forwarded-for': '192.168.1.51',
          origin: 'http://192.168.1.51:3001',
        };
        const challengeRes = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/challenge',
          payload: {},
        });
        expect(challengeRes.statusCode).toBe(200);
        const pairingCode = challengeRes.json().challenge.pairingCode as string;
        expect(pairingCode.length).toBeGreaterThanOrEqual(6);

        // Remote phone cannot create challenge or approve
        const remoteApproveAttempt = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/approve',
          headers: phoneAHeaders,
          payload: { requestId: 'fake' },
        });
        expect(remoteApproveAttempt.statusCode).toBe(403);
        expect(remoteApproveAttempt.json().code).toBe('DESKTOP_ONLY');

        const reqARes = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/request',
          headers: phoneAHeaders,
          payload: { pairingCode, deviceName: 'iPhone Pedro' },
        });
        expect(reqARes.statusCode).toBe(200);
        const { requestId: reqAId, claimSecret: secretA } = reqARes.json() as {
          requestId: string;
          claimSecret: string;
        };

        // Desktop approves Phone A
        const approveARes = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/approve',
          payload: { requestId: reqAId },
        });
        expect(approveARes.statusCode).toBe(200);

        // Phone A polls and receives HttpOnly session cookie
        const pollARes = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/poll',
          headers: phoneAHeaders,
          payload: { requestId: reqAId, claimSecret: secretA },
        });
        expect(pollARes.statusCode).toBe(200);
        expect(pollARes.json().status).toBe('approved');
        const setCookieA = pollARes.headers['set-cookie'];
        const cookieA = (Array.isArray(setCookieA) ? setCookieA[0] : setCookieA)!
          .split(';')[0]!;
        expect(cookieA).toContain('mg300_session=');

        // Phone A can now connect MIDI, change Master Volume, and open authenticated WS
        const midiConnA = await pairingApp.inject({
          method: 'POST',
          url: '/api/midi/connect',
          headers: { ...phoneAHeaders, cookie: cookieA },
          payload: {},
        });
        expect(midiConnA.statusCode).toBe(200);

        const wsA = await connectTestWsClient(`ws://127.0.0.1:${port}/ws`, {
          Origin: 'http://192.168.1.51:3001',
          Cookie: cookieA,
        });
        await wsA.waitForMessage((m) => m.type === 'state_sync');

        // 5. Single mobile controller limit: pairing Phone B immediately revokes Phone A!
        const phoneBHeaders = {
          'x-forwarded-for': '192.168.1.52',
          origin: 'http://192.168.1.52:3001',
        };
        const challenge2Res = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/challenge',
          payload: {},
        });
        const pairingCode2 = challenge2Res.json().challenge.pairingCode as string;

        const reqBRes = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/request',
          headers: phoneBHeaders,
          payload: { pairingCode: pairingCode2, deviceName: 'Galaxy S25' },
        });
        const { requestId: reqBId, claimSecret: secretB } = reqBRes.json() as {
          requestId: string;
          claimSecret: string;
        };

        const wsAClosedPromise = new Promise<number>((resolve) => {
          wsA.ws.once('close', (code) => resolve(code));
        });

        await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/approve',
          payload: { requestId: reqBId },
        });

        expect(await wsAClosedPromise).toBe(4001);

        // Phone A's subsequent HTTP calls are rejected with 401 SESSION_REVOKED
        const phoneARevokedRes = await pairingApp.inject({
          method: 'PUT',
          url: '/api/volume',
          headers: { ...phoneAHeaders, cookie: cookieA },
          payload: { volume: 40 },
        });
        expect(phoneARevokedRes.statusCode).toBe(401);
        expect(phoneARevokedRes.json().code).toBe('SESSION_REVOKED');

        // Phone B obtains session and controls Master Volume
        const pollBRes = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/poll',
          headers: phoneBHeaders,
          payload: { requestId: reqBId, claimSecret: secretB },
        });
        const setCookieB = pollBRes.headers['set-cookie'];
        const cookieB = (Array.isArray(setCookieB) ? setCookieB[0] : setCookieB)!
          .split(';')[0]!;

        const volBRes = await pairingApp.inject({
          method: 'PUT',
          url: '/api/volume',
          headers: { ...phoneBHeaders, cookie: cookieB },
          payload: { volume: 65, target: 'master_cc64' },
        });
        expect(volBRes.statusCode).toBe(200);

        // 6. Paired mobile session still receives full presets/status even if QUICKTONE_AUTH_TOKEN is enabled
        pairingApp.stateManager.setAuthToken('9999');
        const desktopChallengeDenied = await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/challenge',
          payload: {},
        });
        expect(desktopChallengeDenied.statusCode).toBe(401);

        const authedMobilePresets = await pairingApp.inject({
          method: 'GET',
          url: '/api/presets',
          headers: { ...phoneBHeaders, cookie: cookieB },
        });
        expect(authedMobilePresets.statusCode).toBe(200);
        expect(PresetsResponseSchema.parse(authedMobilePresets.json()).presets.length).toBeGreaterThan(0);

        const authedMobileStatus = await pairingApp.inject({
          method: 'GET',
          url: '/api/status',
          headers: { ...phoneBHeaders, cookie: cookieB },
        });
        expect(authedMobileStatus.statusCode).toBe(200);
        expect(ControllerStateSchema.parse(authedMobileStatus.json()).lanUrls?.length).toBeGreaterThanOrEqual(0);
        pairingApp.stateManager.setAuthToken(null);

        // 7. Manual revocation by desktop immediately invalidates Phone B
        await pairingApp.inject({
          method: 'POST',
          url: '/api/pairing/revoke',
          payload: {},
        });
        const afterRevokeB = await pairingApp.inject({
          method: 'GET',
          url: '/api/status',
          headers: { ...phoneBHeaders, cookie: cookieB },
        });
        expect(afterRevokeB.statusCode).toBe(401);
        expect(afterRevokeB.json().code).toBe('SESSION_REVOKED');
      } finally {
        await pairingApp.close();
      }
    });

    it('persists trusted devices across restart, reconnects via trusted-login without QR, and revokes on desktop removal', async () => {
      const trustedStorePath = path.join(tempDir, 'trusted-devices.json');
      const phoneHeaders = {
        'x-forwarded-for': '192.168.1.77',
        origin: 'http://192.168.1.77:3001',
      };

      const app1 = createBackendApp({
        midiAdapter: mockAdapter,
        presetsDirectory: tempDir,
        includeFactoryPresets: false,
        staticDir: null,
        pairingOptions: { trustedDevicesPath: trustedStorePath },
      });

      let trustCookie = '';
      let trustedDeviceId = '';

      try {
        const challengeRes = await app1.inject({
          method: 'POST',
          url: '/api/pairing/challenge',
          payload: {},
        });
        const pairingCode = challengeRes.json().challenge.pairingCode as string;

        const reqRes = await app1.inject({
          method: 'POST',
          url: '/api/pairing/request',
          headers: phoneHeaders,
          payload: { pairingCode, deviceName: 'Galaxy S25 Pedro' },
        });
        const { requestId, claimSecret } = reqRes.json() as {
          requestId: string;
          claimSecret: string;
        };

        await app1.inject({
          method: 'POST',
          url: '/api/pairing/approve',
          payload: { requestId },
        });

        const pollRes = await app1.inject({
          method: 'POST',
          url: '/api/pairing/poll',
          headers: phoneHeaders,
          payload: { requestId, claimSecret },
        });
        const setCookies = pollRes.headers['set-cookie'];
        const cookieList = Array.isArray(setCookies) ? setCookies : [setCookies!];
        const foundTrust = cookieList.find((c) => c.startsWith('mg300_trusted_device='));
        expect(foundTrust).toBeDefined();
        trustCookie = foundTrust!.split(';')[0]!;

        const desktopStatus = await app1.inject({
          method: 'GET',
          url: '/api/pairing/status',
        });
        expect(desktopStatus.json().trustedDevices).toHaveLength(1);
        trustedDeviceId = desktopStatus.json().trustedDevices[0].deviceId as string;
      } finally {
        await app1.close();
      }

      // Simulate server restart loading persisted trusted-devices.json
      const app2 = createBackendApp({
        midiAdapter: mockAdapter,
        presetsDirectory: tempDir,
        includeFactoryPresets: false,
        staticDir: null,
        pairingOptions: { trustedDevicesPath: trustedStorePath },
      });

      try {
        const mobileStatusBefore = await app2.inject({
          method: 'GET',
          url: '/api/pairing/status',
          headers: { ...phoneHeaders, cookie: trustCookie },
        });
        expect(mobileStatusBefore.json().authenticated).toBe(false);
        expect(mobileStatusBefore.json().isTrustedDevice).toBe(true);
        expect(mobileStatusBefore.json().trustedDeviceName).toBe('Galaxy S25 Pedro');

        // Reconnect without QR Code
        const trustedLoginRes = await app2.inject({
          method: 'POST',
          url: '/api/pairing/trusted-login',
          headers: { ...phoneHeaders, cookie: trustCookie },
          payload: {},
        });
        expect(trustedLoginRes.statusCode).toBe(200);
        const sessionCookie = (
          Array.isArray(trustedLoginRes.headers['set-cookie'])
            ? trustedLoginRes.headers['set-cookie'][0]
            : trustedLoginRes.headers['set-cookie']
        )!.split(';')[0]!;

        const authedStatus = await app2.inject({
          method: 'GET',
          url: '/api/status',
          headers: { ...phoneHeaders, cookie: `${sessionCookie}; ${trustCookie}` },
        });
        expect(authedStatus.statusCode).toBe(200);

        // Desktop removes trusted device -> active session revoked & trusted-login denied
        const removeRes = await app2.inject({
          method: 'POST',
          url: '/api/pairing/trusted/remove',
          payload: { deviceId: trustedDeviceId },
        });
        expect(removeRes.statusCode).toBe(200);
        expect(removeRes.json().trustedDevices).toHaveLength(0);

        const afterRemove = await app2.inject({
          method: 'GET',
          url: '/api/status',
          headers: { ...phoneHeaders, cookie: `${sessionCookie}; ${trustCookie}` },
        });
        expect(afterRemove.statusCode).toBe(401);

        const retryLogin = await app2.inject({
          method: 'POST',
          url: '/api/pairing/trusted-login',
          headers: { ...phoneHeaders, cookie: trustCookie },
          payload: {},
        });
        expect(retryLogin.statusCode).toBe(401);
      } finally {
        await app2.close();
      }
    });
  });
});
