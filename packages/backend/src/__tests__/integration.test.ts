import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  MG300_MIDI_CC,
  PresetsResponseSchema,
  type WsServerMessage,
  WsServerMessageSchema,
} from '@quicktone/shared';
import { buildNuxAllPresetsBinary, buildNuxPresetBinary } from '@quicktone/reader';
import { MockMidiAdapter } from '@quicktone/midi';
import { createBackendApp, type QuickToneBackendApp } from '../index.js';

interface IntegrationWsClient {
  ws: WebSocket;
  messages: WsServerMessage[];
  clearMessages: () => void;
  waitForMessage: (
    predicate: (msg: WsServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<WsServerMessage>;
  close: () => Promise<void>;
}

async function connectWsClient(url: string): Promise<IntegrationWsClient> {
  const ws = new WebSocket(url);
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
    timeoutMs = 4000,
  ): Promise<WsServerMessage> => {
    const found = messages.find(predicate);
    if (found) {
      return Promise.resolve(found);
    }

    return new Promise<WsServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        for (const w of waiters) {
          if (w.timer === timer) {
            waiters.delete(w);
          }
        }
        reject(new Error(`WebSocket message wait timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      waiters.add({ predicate, resolve, reject, timer });
    });
  };

  const clearMessages = (): void => {
    messages.length = 0;
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

  return { ws, messages, clearMessages, waitForMessage, close };
}

describe('@quicktone/backend — End-to-End Backend Integration Tests (Section 7)', () => {
  let tempDir: string;
  let mockAdapter: MockMidiAdapter;
  let app: QuickToneBackendApp;
  let serverPort: number;
  let wsUrl: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'quicktone-integration-'),
    );

    mockAdapter = new MockMidiAdapter({
      autoConfirmHardware: false,
    });

    app = createBackendApp({
      midiAdapter: mockAdapter,
      midiOptions: {
        autoReconnect: true,
        reconnectIntervalMs: 40,
        strictMg300Safety: true,
      },
      presetsDirectory: tempDir,
      includeFactoryPresets: false,
      staticDir: null,
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    serverPort = typeof addr === 'object' && addr ? addr.port : 0;
    wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
  });

  afterEach(async () => {
    await app.close();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('Scenario 1: QuickTone binary .nuxpreset files -> REST API & WebSocket presets_updated', async () => {
    const client = await connectWsClient(wsUrl);
    try {
      await client.waitForMessage((m) => m.type === 'state_sync');
      client.clearMessages();

      // Write real binary .nuxpreset files (V1 8,380 B and V2 8,381 B) into the watched directory
      const eaglesPreset = buildNuxPresetBinary({
        name: 'EaglesDF Crunch',
        patchVolume: 62,
        irVolume: 24,
        formatVersion: 'v1',
        fullIrPayload: true,
      });
      const scorpionsPreset = buildNuxPresetBinary({
        name: 'SCORPIONS',
        patchVolume: 78,
        irVolume: 30,
        slotIndex: 1,
        formatVersion: 'v2',
        fullIrPayload: true,
      });

      await fs.promises.writeFile(
        path.join(tempDir, 'EaglesDF Crunch.nuxpreset'),
        eaglesPreset,
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'SCORPIONS.nuxpreset'),
        scorpionsPreset,
      );

      // Re-configure / trigger discovery via API and verify WebSocket broadcast + REST response
      const configRes = await app.inject({
        method: 'POST',
        url: '/api/presets/config',
        payload: {
          directoryPath: tempDir,
          includeFactoryPresets: false,
        },
      });

      expect(configRes.statusCode).toBe(200);
      const presetsFromConfig = PresetsResponseSchema.parse(configRes.json());
      expect(presetsFromConfig.presets).toHaveLength(2);
      expect(presetsFromConfig.presets[0]?.id).toBe('1A');
      expect(presetsFromConfig.presets[0]?.name).toBe('EaglesDF Crunch');
      expect(presetsFromConfig.presets[0]?.patchVolume).toBe(62);
      expect(presetsFromConfig.presets[1]?.id).toBe('1B');
      expect(presetsFromConfig.presets[1]?.name).toBe('SCORPIONS');
      expect(presetsFromConfig.presets[1]?.patchVolume).toBe(78);

      // Verify WebSocket received presets_updated
      const wsPresetsMsg = await client.waitForMessage(
        (m) => m.type === 'presets_updated' && m.presets.length === 2,
      );
      expect(wsPresetsMsg.type).toBe('presets_updated');
      if (wsPresetsMsg.type === 'presets_updated') {
        expect(wsPresetsMsg.presets.map((p) => p.name)).toEqual([
          'EaglesDF Crunch',
          'SCORPIONS',
        ]);
      }

      // Also verify 36-preset bundle MG300AllPreset.nuxpreset
      const bundleDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'quicktone-bundle-'),
      );
      try {
        const bundleBytes = buildNuxAllPresetsBinary(
          [
            { name: 'Clean 1A', patchVolume: 55 },
            { name: 'Crunch 1B', patchVolume: 65 },
            { name: 'Lead 1C', patchVolume: 80 },
            { name: 'Ambient 1D', patchVolume: 60 },
          ],
          'v2',
          false,
        );
        await fs.promises.writeFile(
          path.join(bundleDir, 'MG300AllPreset.nuxpreset'),
          bundleBytes,
        );

        const bundleRes = await app.inject({
          method: 'POST',
          url: '/api/presets/config',
          payload: { directoryPath: bundleDir },
        });
        expect(bundleRes.statusCode).toBe(200);
        const bundleData = PresetsResponseSchema.parse(bundleRes.json());
        expect(bundleData.presets).toHaveLength(36);
        expect(bundleData.presets[0]?.name).toBe('Clean 1A');
        expect(bundleData.presets[2]?.name).toBe('Lead 1C');
        expect(bundleData.presets[35]?.displayBank).toBe('9D');
      } finally {
        await fs.promises.rm(bundleDir, { recursive: true, force: true });
      }
    } finally {
      await client.close();
    }
  });

  it('Scenario 2: API/Interface -> MIDI Mock exact bytes [0xB0, 0x3C, slot] & [0xB0, 0x40, vol] + hardware confirmation', async () => {
    const preset2C = buildNuxPresetBinary({
      name: 'Plexi Solo',
      patchVolume: 82,
      slotIndex: 6, // 2C
      formatVersion: 'v2',
    });
    await fs.promises.writeFile(path.join(tempDir, 'PlexiSolo.nuxpreset'), preset2C);
    await app.inject({
      method: 'POST',
      url: '/api/presets/config',
      payload: { directoryPath: tempDir },
    });

    // Connect MIDI
    const connectRes = await app.inject({
      method: 'POST',
      url: '/api/midi/connect',
      payload: {},
    });
    expect(connectRes.statusCode).toBe(200);

    // Select Preset 2C (slotIndex 6)
    const selectRes = await app.inject({
      method: 'POST',
      url: '/api/presets/select',
      payload: { presetId: '2C' },
    });
    expect(selectRes.statusCode).toBe(200);

    // Adjust Master Volume to 88
    const volumeRes = await app.inject({
      method: 'PUT',
      url: '/api/volume',
      payload: { volume: 88, target: 'master_cc64' },
    });
    expect(volumeRes.statusCode).toBe(200);

    // Adjust Patch Volume P.LVL to 74
    const patchVolRes = await app.inject({
      method: 'PUT',
      url: '/api/volume',
      payload: { volume: 74, target: 'patch_cc74' },
    });
    expect(patchVolRes.statusCode).toBe(200);

    // Verify exact bytes recorded by MockMidiAdapter
    const sentMessages = mockAdapter.getSentMessages();
    expect(sentMessages).toEqual([
      [0xb0, MG300_MIDI_CC.PRESET_SELECT, 6], // CC 0x3C = 6 (2C)
      [0xb0, MG300_MIDI_CC.MASTER_VOLUME, 88], // CC 0x40 = 88
      [0xb0, MG300_MIDI_CC.PATCH_LEVEL, 74], // CC 0x4A = 74
    ]);

    // Simulate hardware MIDI IN echo confirming preset 2C and patch volume 74
    mockAdapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.PRESET_SELECT, 6]);
    mockAdapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.PATCH_LEVEL, 74]);

    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/status',
    });
    const finalState = statusRes.json();
    expect(finalState.syncStatus).toBe('confirmed');
    expect(finalState.confirmedState.presetId).toBe('2C');
    expect(finalState.confirmedState.slotIndex).toBe(6);
    expect(finalState.confirmedState.volume).toBe(74);
    expect(finalState.confirmedState.volumeTarget).toBe('patch_cc74');
  });

  it('Scenario 3: Multi-client real-time WebSocket synchronization when Client A changes preset and volume', async () => {
    const preset1A = buildNuxPresetBinary({
      name: 'Clean Chorus',
      patchVolume: 50,
      slotIndex: 0,
      formatVersion: 'v2',
    });
    const preset1B = buildNuxPresetBinary({
      name: 'High Gain 1B',
      patchVolume: 85,
      slotIndex: 1,
      formatVersion: 'v2',
    });
    await fs.promises.writeFile(path.join(tempDir, '01_Clean.nuxpreset'), preset1A);
    await fs.promises.writeFile(path.join(tempDir, '02_HighGain.nuxpreset'), preset1B);

    await app.inject({
      method: 'POST',
      url: '/api/presets/config',
      payload: { directoryPath: tempDir },
    });
    await app.inject({
      method: 'POST',
      url: '/api/midi/connect',
      payload: {},
    });

    const clientA = await connectWsClient(wsUrl);
    const clientB = await connectWsClient(wsUrl);

    try {
      // Wait for initial state_sync on both clients
      await clientA.waitForMessage((m) => m.type === 'state_sync');
      await clientB.waitForMessage((m) => m.type === 'state_sync');
      clientA.clearMessages();
      clientB.clearMessages();

      // Enable autoConfirmHardware to verify both unconfirmed and confirmed broadcasts reach both clients
      mockAdapter.setAutoConfirmHardware(true);

      // Client A triggers preset change to 1B via HTTP POST
      const selectRes = await app.inject({
        method: 'POST',
        url: '/api/presets/select',
        payload: { presetId: '1B' },
      });
      expect(selectRes.statusCode).toBe(200);

      // Both Client A and Client B must receive the synchronized preset state in real time
      const syncPresetA = await clientA.waitForMessage(
        (m) =>
          m.type === 'state_sync' &&
          m.state.confirmedState.presetId === '1B' &&
          m.state.syncStatus === 'confirmed',
      );
      const syncPresetB = await clientB.waitForMessage(
        (m) =>
          m.type === 'state_sync' &&
          m.state.confirmedState.presetId === '1B' &&
          m.state.syncStatus === 'confirmed',
      );

      expect(syncPresetA.type).toBe('state_sync');
      expect(syncPresetB.type).toBe('state_sync');

      clientA.clearMessages();
      clientB.clearMessages();

      // Client A changes volume to 92 via HTTP PUT
      const volRes = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        payload: { volume: 92, target: 'master_cc64' },
      });
      expect(volRes.statusCode).toBe(200);

      // Both Client A and Client B must receive the synchronized volume state in real time
      const syncVolA = await clientA.waitForMessage(
        (m) =>
          m.type === 'state_sync' &&
          m.state.confirmedState.volume === 92 &&
          m.state.syncStatus === 'confirmed',
      );
      const syncVolB = await clientB.waitForMessage(
        (m) =>
          m.type === 'state_sync' &&
          m.state.confirmedState.volume === 92 &&
          m.state.syncStatus === 'confirmed',
      );

      expect(syncVolA.type).toBe('state_sync');
      expect(syncVolB.type).toBe('state_sync');
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });

  it('Scenario 4: Unexpected USB-MIDI disconnect and automatic reconnection propagated to WebSocket clients', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/midi/connect',
      payload: {},
    });

    const client = await connectWsClient(wsUrl);
    try {
      const initial = await client.waitForMessage(
        (m) => m.type === 'state_sync' && m.state.connectionState === 'connected',
      );
      expect(initial.type).toBe('state_sync');
      client.clearMessages();

      // Simulate physical USB cable unplug (removing port temporarily)
      mockAdapter.simulateUnexpectedDisconnect('USB device unplugged', true);

      const reconnectingMsg = await client.waitForMessage(
        (m) => m.type === 'state_sync' && m.state.connectionState === 'reconnecting',
      );
      expect(reconnectingMsg.type).toBe('state_sync');
      if (reconnectingMsg.type === 'state_sync') {
        expect(reconnectingMsg.state.connectedPortName).toBeNull();
        expect(reconnectingMsg.state.syncStatus).toBe('unknown');
        expect(reconnectingMsg.state.lastError?.code).toBe('DISCONNECTED');
      }

      client.clearMessages();

      // Simulate physical USB cable plugged back in
      mockAdapter.simulateDeviceReconnected();

      // Automatic reconnect loop must recover connection and broadcast 'connected' to WebSocket client
      const recoveredMsg = await client.waitForMessage(
        (m) => m.type === 'state_sync' && m.state.connectionState === 'connected',
        3000,
      );
      expect(recoveredMsg.type).toBe('state_sync');
      if (recoveredMsg.type === 'state_sync') {
        expect(recoveredMsg.state.connectedPortName).toBe('NUX NME-300');
        expect(recoveredMsg.state.lastError).toBeNull();
      }
    } finally {
      await client.close();
    }
  });
});
