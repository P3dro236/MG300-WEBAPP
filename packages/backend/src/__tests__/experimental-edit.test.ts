import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMg300IdentityQuerySysEx,
  buildMg300PresetWriteSysEx,
  MG300_EXPERIMENTAL_SLOT,
  MG300_SYSEX_PREFIX,
  MG300_USER_IR_CAB_ID,
} from '@quicktone/shared';
import { MockMidiAdapter, MidiDiagnosticsLogger, MidiService } from '@quicktone/midi';
import {
  buildMg300Struct102,
  buildNuxAllPresetsBinary,
  buildNuxPresetBinary,
} from '@quicktone/reader';
import { createBackendApp, type QuickToneBackendApp } from '../app.js';
import { ExperimentalEditService } from '../experimental-edit.js';

/** Mock pedal: answers identity, per-slot Flash reads (0x07 -> 0x06) and 0x0E writes with ACK. */
class FakePedalAdapter extends MockMidiAdapter {
  public readonly flashSlots = new Map<number, Uint8Array>([
    [MG300_EXPERIMENTAL_SLOT, buildMg300Struct102({ name: 'Original 4D' })],
    [16, buildMg300Struct102({ name: 'Existing 5A' })],
  ]);
  public ackWrites = true;
  public answerIdentity = true;
  public answerDump = true;

  public get flashSlot(): Uint8Array {
    return this.getSlotStruct(MG300_EXPERIMENTAL_SLOT);
  }

  public getSlotStruct(slotIndex: number): Uint8Array {
    return this.flashSlots.get(slotIndex) ?? buildMg300Struct102({ name: `Slot ${slotIndex}` });
  }

  public override async sendBytes(bytes: number[]): Promise<void> {
    await super.sendBytes(bytes);
    const isSysEx = bytes[0] === 0xf0;
    if (!isSysEx) return;

    if (bytes.join() === buildMg300IdentityQuerySysEx().join()) {
      if (!this.answerIdentity) return;
      const reply = [...MG300_SYSEX_PREFIX, 0x10, ...Buffer.from('V01_20191106'.padEnd(32, '\0')),
        ...Buffer.from('NUX_MG1X'), 0xf7];
      queueMicrotask(() => this.simulateHardwareIncoming(reply));
    } else if (bytes[7] === 0x07) {
      if (!this.answerDump) return;
      const slotIndex = bytes[8] ?? MG300_EXPERIMENTAL_SLOT;
      queueMicrotask(() => this.simulateHardwareIncoming(this.dumpFrame(slotIndex)));
    } else if (bytes[7] === 0x0e && this.ackWrites) {
      const slotIndex = bytes[8]!;
      this.flashSlots.set(slotIndex, this.decodeWrite(bytes));
      queueMicrotask(() =>
        this.simulateHardwareIncoming([...MG300_SYSEX_PREFIX, 0x70, 0x0e, slotIndex, 0xf7]),
      );
    }
  }

  private dumpFrame(slotIndex: number): number[] {
    const s = this.getSlotStruct(slotIndex);
    return [
      ...MG300_SYSEX_PREFIX, 0x70, 0x06, slotIndex,
      ...s.subarray(0, 100), s[100]! >> 4, s[100]! & 0xf, s[101]!, 0xf7,
    ];
  }

  private decodeWrite(frame: number[]): Uint8Array {
    const out = new Uint8Array(102);
    out.set(frame.slice(9, 109));
    out[100] = (frame[109]! << 4) | frame[110]!;
    out[101] = frame[111]!;
    return out;
  }
}

describe('experimental preset edit API', () => {
  let adapter: FakePedalAdapter;
  let backupDir: string;
  let app: QuickToneBackendApp;

  const buildApp = (experimentalEdit: boolean): QuickToneBackendApp =>
    createBackendApp({
      midiAdapter: adapter,
      experimentalEdit,
      experimentalBackupDir: backupDir,
      staticDir: null,
      includeFactoryPresets: false,
      pairingOptions: undefined,
    });

  beforeEach(() => {
    adapter = new FakePedalAdapter();
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-backup-'));
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  it('does not expose the routes unless the flag is on', async () => {
    app = buildApp(false);
    const res = await app.inject({ method: 'GET', url: '/api/experimental/state' });
    expect(res.statusCode).toBe(404);
  });

  it('edits live over CC, saves slot 4D with backup, ACK and identical readback', async () => {
    app = buildApp(true);
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });

    const load = await app.inject({ method: 'POST', url: '/api/experimental/load' });
    expect(load.statusCode).toBe(200);
    expect(load.json().slot).toBe(15);
    expect(load.json().busy).toBe(false);
    expect(load.json().presetName).toBe('Original 4D');
    expect(adapter.getSentMessages()).toContainEqual([0xb0, 0x3c, MG300_EXPERIMENTAL_SLOT]);

    await app.inject({ method: 'PUT', url: '/api/experimental/param', payload: { index: 0, value: 77 } });
    await app.inject({ method: 'PUT', url: '/api/experimental/block', payload: { block: 3, on: true } });
    expect(adapter.getSentMessages()).toContainEqual([0xb0, 23, 77]);

    const save = await app.inject({
      method: 'POST',
      url: '/api/experimental/save',
      payload: { confirmSlot: MG300_EXPERIMENTAL_SLOT },
    });
    expect(save.statusCode).toBe(200);
    const result = save.json();
    expect(result.ackReceived).toBe(true);
    expect(result.verified).toBe(true);
    expect(adapter.flashSlot[0x1a]).toBe(77);
    expect(path.basename(result.backupPath)).toBe(result.backupPath);
    const fullBackupFile = path.join(backupDir, result.backupPath);
    expect(fs.existsSync(fullBackupFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(fullBackupFile, 'utf8')).name).toBe('Original 4D');

    const stateAfterSave = await app.inject({ method: 'GET', url: '/api/experimental/state' });
    expect(stateAfterSave.statusCode).toBe(200);
    expect(stateAfterSave.json().busy).toBe(false);
    expect(stateAfterSave.json().lastSave.backupPath).toBe(result.backupPath);
  });

  it('reports a failed save when the pedal never ACKs', async () => {
    app = buildApp(true);
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
    await app.inject({ method: 'POST', url: '/api/experimental/load' });
    adapter.ackWrites = false;

    const save = await app.inject({
      method: 'POST',
      url: '/api/experimental/save',
      payload: { confirmSlot: MG300_EXPERIMENTAL_SLOT },
    });
    expect(save.json().ackReceived).toBe(false);
    expect(save.json().verified).toBe(false);
  }, 10000);

  it('rejects out-of-range params and strictly blocks Factory slots (36..71)', async () => {
    app = buildApp(true);
    await app.ready();
    const badParam = await app.inject({
      method: 'PUT',
      url: '/api/experimental/param',
      payload: { index: 9, value: 500 },
    });
    expect(badParam.statusCode).toBe(400);
    const factorySlotF1A = await app.inject({
      method: 'POST',
      url: '/api/experimental/save',
      payload: { confirmSlot: 36 },
    });
    expect(factorySlotF1A.statusCode).toBe(400);
    const factorySlotF9D = await app.inject({
      method: 'POST',
      url: '/api/experimental/save',
      payload: { confirmSlot: 71 },
    });
    expect(factorySlotF9D.statusCode).toBe(400);
  });

  it('returns user-friendly messages and writes technical details to diagnostic log on identity/dump timeouts', async () => {
    const logPath = path.join(backupDir, 'midi-diagnostics.log');
    const logger = new MidiDiagnosticsLogger({ logFilePath: logPath, enabled: true });
    const service = new MidiService(adapter, { experimentalEdit: true, logger });
    await service.connect();

    const exp = new ExperimentalEditService(service, {
      backupDir,
      identityTimeoutMs: 250,
      dumpTimeoutMs: 250,
      logger,
    });

    adapter.answerIdentity = false;
    await expect(exp.load()).rejects.toMatchObject({
      code: 'IDENTITY_NOT_CONFIRMED',
      statusCode: 503,
    });
    try {
      await exp.load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      expect(msg).not.toMatch(/NUX_MG1X|0x06|0x0E|mmresult|WinMM/i);
    }

    adapter.answerIdentity = true;
    adapter.answerDump = false;
    try {
      await exp.load();
      expect.unreachable('Expected DUMP_TIMEOUT');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      expect(msg).toMatch(/4D/);
      expect(msg).not.toMatch(/0x06|SysEx|mmresult|WinMM/i);
    }

    const logContent = fs.readFileSync(logPath, 'utf8');
    expect(logContent).toContain('IDENTITY_NOT_CONFIRMED');
    expect(logContent).toContain('NUX_MG1X');
    expect(logContent).toContain('DUMP_TIMEOUT');

    // Verify waitForAck timer/listener is cancelled immediately when preset write fails
    adapter.answerDump = true;
    await exp.load();
    const expShortAck = new ExperimentalEditService(service, {
      backupDir,
      identityTimeoutMs: 250,
      dumpTimeoutMs: 250,
      ackTimeoutMs: 120,
      logger,
    });
    await expShortAck.load();
    const originalSendBytes = adapter.sendBytes.bind(adapter);
    adapter.sendBytes = async (bytes: number[]): Promise<void> => {
      if (bytes[0] === 0xf0 && bytes[7] === 0x0e) {
        throw new Error('Simulated write failure');
      }
      return originalSendBytes(bytes);
    };
    await expect(expShortAck.save()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const logAfterFailedSave = fs.readFileSync(logPath, 'utf8');
    expect(logAfterFailedSave).not.toContain('Timed out waiting for 0x0E write ACK');

    expShortAck.dispose();
    exp.dispose();
    service.dispose();
  });

  it('builds a 113-byte frame for User slots (0..35) and refuses Factory slots (>= 36) at the protocol level', () => {
    const frame = buildMg300PresetWriteSysEx(buildMg300Struct102({ name: 'X' }));
    expect(frame).toHaveLength(113);
    expect(buildMg300PresetWriteSysEx(buildMg300Struct102({ name: '2A' }), 4)).toHaveLength(113);
    expect(() => buildMg300PresetWriteSysEx(new Uint8Array(102), 36)).toThrow();
    expect(() => buildMg300PresetWriteSysEx(new Uint8Array(102), 71)).toThrow();
    expect(() => buildMg300PresetWriteSysEx(new Uint8Array(102), -1)).toThrow();
  });

  it('keeps the MidiService write guard closed without the flag', async () => {
    const service = new MidiService(new MockMidiAdapter());
    await service.connect();
    await expect(service.sendExperimentalControlChange(23, 10)).rejects.toThrow(/desativada/);
  });

  it('edits EQ/DLY block params and Patch/IR levels in real time over MIDI CC without touching Flash', async () => {
    app = buildApp(true);
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
    await app.inject({ method: 'POST', url: '/api/experimental/load' });

    const eqRes = await app.inject({
      method: 'PUT',
      url: '/api/experimental/block-param',
      payload: { block: 4, index: 2, value: 64 },
    });
    expect(eqRes.statusCode).toBe(200);
    expect(eqRes.json().blockParams['4'][2]).toBe(64);
    expect(adapter.getSentMessages()).toContainEqual([0xb0, 31, 64]);

    const patchLvlRes = await app.inject({
      method: 'PUT',
      url: '/api/experimental/level',
      payload: { target: 'patchVolume', value: 82 },
    });
    expect(patchLvlRes.statusCode).toBe(200);
    expect(patchLvlRes.json().patchVolume).toBe(82);
    expect(adapter.getSentMessages()).toContainEqual([0xb0, 74, 82]);

    const badIrVol = await app.inject({
      method: 'PUT',
      url: '/api/experimental/level',
      payload: { target: 'irVolume', value: 55 },
    });
    expect(badIrVol.statusCode).toBe(400);

    // Selecting another preset outside 4D invalidates the active 4D draft
    await app.inject({
      method: 'POST',
      url: '/api/presets/select',
      payload: { slotIndex: 0, presetId: '1A' },
    });
    const afterPresetChange = await app.inject({ method: 'GET', url: '/api/experimental/state' });
    expect(afterPresetChange.json().loaded).toBe(false);

    // Enforces authToken on GET /api/experimental/state and mutating endpoints when configured
    app.stateManager.setAuthToken('4321');
    const unauthState = await app.inject({ method: 'GET', url: '/api/experimental/state' });
    expect(unauthState.statusCode).toBe(401);
    const unauthNew = await app.inject({
      method: 'POST',
      url: '/api/experimental/new',
      payload: { presetName: 'Blocked' },
    });
    expect(unauthNew.statusCode).toBe(401);
  });

  it('switches pedal models across all 10 blocks, resyncs RAM params after CC 1..8 > 0, and clears CAB when AMP turns off', async () => {
    app = buildApp(true);
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
    await app.inject({ method: 'POST', url: '/api/experimental/load' });

    // Switch EFX (block 2) to T Screamer (id=5): must send CC 2=5 then resync Level(17)/Tone(18)/Drive(19)
    const efxRes = await app.inject({
      method: 'PUT',
      url: '/api/experimental/block-model',
      payload: { block: 2, modelId: 5 },
    });
    expect(efxRes.statusCode).toBe(200);
    expect(efxRes.json().blockModels['2']).toBe(5);
    const sentAfterEfx = adapter.getSentMessages();
    const cc2Idx = sentAfterEfx.findIndex((m) => m[0] === 0xb0 && m[1] === 2 && m[2] === 5);
    expect(cc2Idx).toBeGreaterThan(-1);
    const trailingEfxCcs = sentAfterEfx.slice(cc2Idx + 1);
    expect(trailingEfxCcs).toContainEqual([0xb0, 17, 50]);
    expect(trailingEfxCcs).toContainEqual([0xb0, 18, 50]);
    expect(trailingEfxCcs).toContainEqual([0xb0, 19, 50]);

    // Select CAB=100 (User IR) and MIC=4 (Cond C414)
    const cabRes = await app.inject({
      method: 'PUT',
      url: '/api/experimental/block-model',
      payload: { block: 9, modelId: MG300_USER_IR_CAB_ID },
    });
    expect(cabRes.statusCode).toBe(200);
    expect(cabRes.json().hasUserIr).toBe(true);
    expect(cabRes.json().userIrWarning).toMatch(/User IR/i);

    const micRes = await app.inject({
      method: 'PUT',
      url: '/api/experimental/block-model',
      payload: { block: 10, modelId: 4 },
    });
    expect(micRes.statusCode).toBe(200);
    expect(micRes.json().blockModels['10']).toBe(4);
    expect(adapter.getSentMessages()).toContainEqual([0xb0, 10, 4]);

    // Turning AMP (block 3) OFF must also clear CAB locally per STM32 behavior
    const ampOffRes = await app.inject({
      method: 'PUT',
      url: '/api/experimental/block-model',
      payload: { block: 3, modelId: 0 },
    });
    expect(ampOffRes.statusCode).toBe(200);
    expect(ampOffRes.json().blockModels['3']).toBe(0);
    expect(ampOffRes.json().cabModel).toBe(0);
    expect(ampOffRes.json().cabEnabled).toBe(false);

    // Reject invalid model IDs (e.g. AMP 28 / CAB 55)
    const badModel = await app.inject({
      method: 'PUT',
      url: '/api/experimental/block-model',
      payload: { block: 3, modelId: 28 },
    });
    expect(badModel.statusCode).toBe(400);
  });

  it('creates a new preset offline, edits name/BPM, backs up destination slot 5A, writes via 0x0E, and refreshes GET /api/presets', async () => {
    app = buildApp(true);
    await app.ready();

    // Creating/editing draft works offline without sending MIDI
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/experimental/new',
      payload: { presetName: 'Brazuca Lead', bpm: 132, timeFlag: 1 },
    });
    expect(createRes.statusCode).toBe(200);
    expect(createRes.json().sourceMode).toBe('draft');
    expect(createRes.json().presetName).toBe('Brazuca Lead');
    expect(createRes.json().bpm).toBe(132);
    expect(adapter.getSentMessages()).toHaveLength(0);

    const metaRes = await app.inject({
      method: 'PUT',
      url: '/api/experimental/meta',
      payload: { presetName: 'Canção Solo 5A', bpm: 118, timeFlag: 0 },
    });
    expect(metaRes.statusCode).toBe(200);
    expect(metaRes.json().presetName).toBe('Cancao Solo 5A');
    expect(metaRes.json().bpm).toBe(118);

    // Connect pedal and save to User slot 5A (index 16)
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });
    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/experimental/save',
      payload: { confirmSlot: 16 },
    });
    expect(saveRes.statusCode).toBe(200);
    const saved = saveRes.json();
    expect(saved.targetSlot).toBe(16);
    expect(saved.displayBank).toBe('5A');
    expect(saved.ackReceived).toBe(true);
    expect(saved.verified).toBe(true);
    expect(path.basename(saved.backupPath)).toBe(saved.backupPath);
    const full5aBackup = path.join(backupDir, saved.backupPath);
    expect(fs.existsSync(full5aBackup)).toBe(true);
    expect(JSON.parse(fs.readFileSync(full5aBackup, 'utf8')).name).toBe('Existing 5A');

    // Saving into 5A (16) must select slot 16 on the pedal so subsequent live CCs edit 5A RAM
    expect(adapter.getSentMessages()).toContainEqual([0xb0, 0x3c, 16]);

    // Preset list immediately reflects the newly saved preset at 5A
    const presetsRes = await app.inject({ method: 'GET', url: '/api/presets' });
    const slot5a = (presetsRes.json().presets as Array<{ slotIndex: number; name: string }>).find(
      (p) => p.slotIndex === 16,
    );
    expect(slot5a?.name).toBe('Cancao Solo 5A');
  });

  it('keeps loaded draft intact after unrelated volume events when confirmedState had an older slot, and enforces per-model param bounds', async () => {
    app = buildApp(true);
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/midi/connect', payload: {} });

    // Pre-populate confirmedState.slotIndex = 0 via hardware preset CC echo
    adapter.simulateHardwareIncoming([0xb0, 0x3c, 0]);
    expect(app.stateManager.getState().confirmedState.slotIndex).toBe(0);

    // Load 4D (slot 15) and then adjust Master Volume: draft must NOT be wiped
    const loadRes = await app.inject({
      method: 'POST',
      url: '/api/experimental/load',
      payload: { slot: MG300_EXPERIMENTAL_SLOT },
    });
    expect(loadRes.statusCode).toBe(200);
    expect(loadRes.json().loaded).toBe(true);

    const volRes = await app.inject({
      method: 'PUT',
      url: '/api/volume',
      payload: { volume: 65, target: 'master_cc64' },
    });
    expect(volRes.statusCode).toBe(200);

    const afterVol = await app.inject({ method: 'GET', url: '/api/experimental/state' });
    expect(afterVol.json().loaded).toBe(true);
    expect(afterVol.json().slot).toBe(MG300_EXPERIMENTAL_SLOT);

    // Select AMP model 18 (Brit 800 has toggle Bright on index 1, max=1) -> value=2 rejected with 400
    await app.inject({
      method: 'PUT',
      url: '/api/experimental/block-model',
      payload: { block: 3, modelId: 18 },
    });
    const invalidToggle = await app.inject({
      method: 'PUT',
      url: '/api/experimental/block-param',
      payload: { block: 3, index: 1, value: 2 },
    });
    expect(invalidToggle.statusCode).toBe(400);
    const validToggle = await app.inject({
      method: 'PUT',
      url: '/api/experimental/block-param',
      payload: { block: 3, index: 1, value: 1 },
    });
    expect(validToggle.statusCode).toBe(200);
  });

  it('serializes concurrent mutations, rolls back failed setBlockModel atomically, enforces save rate limit, and hides pairing secrets when authToken is set', async () => {
    const service = new MidiService(adapter, { experimentalEdit: true });
    await service.connect();
    const exp = new ExperimentalEditService(service, {
      backupDir,
      modelResyncDelayMs: 40,
      settleMs: 10,
      minSaveIntervalMs: 5000,
    });
    await exp.load(MG300_EXPERIMENTAL_SLOT);

    // Atomic rollback if MIDI fails mid-setBlockModel
    const prevModel = exp.getState().blockModels['2'];
    const prevParams = [...(exp.getState().blockParams['2'] ?? [])];
    const origSend = adapter.sendBytes.bind(adapter);
    let failNextEfxParam = true;
    adapter.sendBytes = async (bytes: number[]): Promise<void> => {
      if (failNextEfxParam && bytes[0] === 0xb0 && bytes[1] === 18) {
        failNextEfxParam = false;
        throw new Error('Simulated CC drop');
      }
      return origSend(bytes);
    };
    await expect(exp.setBlockModel(2, 5)).rejects.toThrow();
    expect(exp.getState().blockModels['2']).toBe(prevModel);
    expect(exp.getState().blockParams['2']).toEqual(prevParams);
    adapter.sendBytes = origSend;

    // Concurrent setBlockModel + save: save drains in-flight resync and writes complete model 5
    const modelPromise = exp.setBlockModel(2, 5);
    await new Promise((r) => setTimeout(r, 10));
    const savePromise = exp.save(MG300_EXPERIMENTAL_SLOT);
    const [modelState, saveRes] = await Promise.all([modelPromise, savePromise]);
    expect(modelState.blockModels['2']).toBe(5);
    expect(saveRes.verified).toBe(true);
    expect(adapter.flashSlot[2]).toBe(5);

    // Second immediate save hits SAVE_RATE_LIMITED (429)
    await expect(exp.save(MG300_EXPERIMENTAL_SLOT)).rejects.toMatchObject({
      code: 'SAVE_RATE_LIMITED',
      statusCode: 429,
    });

    // Two simultaneous saves reject the second with DEVICE_BUSY (409)
    const expNoCooldown = new ExperimentalEditService(service, {
      backupDir,
      settleMs: 40,
      minSaveIntervalMs: 0,
    });
    await expNoCooldown.load(MG300_EXPERIMENTAL_SLOT);
    const s1 = expNoCooldown.save(MG300_EXPERIMENTAL_SLOT);
    const s2 = expNoCooldown.save(MG300_EXPERIMENTAL_SLOT);
    await expect(s2).rejects.toMatchObject({ code: 'DEVICE_BUSY', statusCode: 409 });
    expect((await s1).verified).toBe(true);

    expNoCooldown.dispose();
    exp.dispose();
    service.dispose();

    // GET /api/pairing/status must not leak desktop pairing secrets when authToken is required and absent
    app = buildApp(true);
    await app.ready();
    app.stateManager.setAuthToken('9876');
    const createChallenge = await app.inject({
      method: 'POST',
      url: '/api/pairing/challenge',
      headers: { 'x-quicktone-token': '9876' },
    });
    expect(createChallenge.statusCode).toBe(200);

    const unauthStatus = await app.inject({ method: 'GET', url: '/api/pairing/status' });
    expect(unauthStatus.statusCode).toBe(200);
    expect(unauthStatus.json().authenticated).toBe(false);
    expect(unauthStatus.json().activeChallenge).toBeNull();
    expect(unauthStatus.json().lanUrls).toEqual([]);
    expect(unauthStatus.json().trustedDevices).toEqual([]);

    const authStatus = await app.inject({
      method: 'GET',
      url: '/api/pairing/status',
      headers: { 'x-quicktone-token': '9876' },
    });
    expect(authStatus.statusCode).toBe(200);
    expect(authStatus.json().authenticated).toBe(true);
    expect(authStatus.json().activeChallenge?.pairingCode).toBeTruthy();
  });

  it('imports single .nuxpreset and 36-slot bundles, surfaces User IR warnings, and rejects invalid/oversized files', async () => {
    app = buildApp(true);
    await app.ready();

    // Single preset with CAB=100 (User IR)
    const presetBuf = buildNuxPresetBinary({ name: 'Boutique Lead', formatVersion: 'v2' });
    presetBuf[0x26 + 0x09] = MG300_USER_IR_CAB_ID;
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/experimental/import',
      payload: {
        fileName: 'boutique.nuxpreset',
        contentBase64: Buffer.from(presetBuf).toString('base64'),
      },
    });
    expect(importRes.statusCode).toBe(200);
    expect(importRes.json().importedCount).toBe(1);
    expect(importRes.json().state.sourceMode).toBe('imported');
    expect(importRes.json().state.presetName).toBe('Boutique Lead');
    expect(importRes.json().state.hasUserIr).toBe(true);
    expect(importRes.json().state.userIrWarning).toMatch(/User IR/i);

    // 36-slot bundle importing specific slot 4
    const bundleBuf = buildNuxAllPresetsBinary(
      Array.from({ length: 36 }, (_, idx) => ({ name: `Pack Patch ${idx + 1}` })),
      'v2',
    );
    const bundleRes = await app.inject({
      method: 'POST',
      url: '/api/experimental/import',
      payload: {
        fileName: 'MG300AllPreset.nuxpreset',
        contentBase64: Buffer.from(bundleBuf).toString('base64'),
        bundleSlotIndex: 3,
      },
    });
    expect(bundleRes.statusCode).toBe(200);
    expect(bundleRes.json().importedCount).toBe(36);
    expect(bundleRes.json().bundleSlots).toHaveLength(36);
    expect(bundleRes.json().state.presetName).toBe('Pack Patch 4');

    // Reject invalid/corrupt base64/binary or oversized (> 512 KB) upload
    const corruptRes = await app.inject({
      method: 'POST',
      url: '/api/experimental/import',
      payload: {
        fileName: 'bad.nuxpreset',
        contentBase64: Buffer.from('not-a-nuxpreset-file').toString('base64'),
      },
    });
    expect(corruptRes.statusCode).toBe(400);

    const oversized = Buffer.alloc(520 * 1024, 0x41).toString('base64');
    const oversizedRes = await app.inject({
      method: 'POST',
      url: '/api/experimental/import',
      payload: {
        fileName: 'huge.nuxpreset',
        contentBase64: oversized,
      },
    });
    expect(oversizedRes.statusCode).toBe(400);
  });

  it('discards an active draft or imported preset cleanly via POST /api/experimental/discard', async () => {
    app = buildApp(true);
    await app.ready();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/experimental/new',
      payload: { presetName: 'Draft To Discard' },
    });
    expect(createRes.statusCode).toBe(200);
    expect(createRes.json().loaded).toBe(true);
    expect(createRes.json().dirty).toBe(true);

    const discardRes = await app.inject({
      method: 'POST',
      url: '/api/experimental/discard',
      payload: {},
    });
    expect(discardRes.statusCode).toBe(200);
    expect(discardRes.json().loaded).toBe(false);
    expect(discardRes.json().dirty).toBe(false);
    expect(discardRes.json().sourceMode).toBe('hardware');
    expect(discardRes.json().sourceFileName).toBeNull();
  });
});
