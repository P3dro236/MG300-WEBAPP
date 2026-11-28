import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMg300PresetWriteSysEx,
  compareStruct102Readback,
  isExperimentalPresetWriteSysEx,
  sanitizeStruct102ForSysEx,
} from '@quicktone/shared';
import { buildMg300Struct102 } from '@quicktone/reader';
import {
  groupWinMmRawPorts,
  MidiService,
  MidiServiceError,
  MockMidiAdapter,
  WinMmMidiAdapter,
} from '../index.js';

const activeServices: MidiService[] = [];
const tempDirsToClean: string[] = [];

afterEach(async () => {
  for (const service of activeServices.splice(0)) {
    await service.disconnect().catch(() => undefined);
    service.dispose();
  }
  for (const dir of tempDirsToClean.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('S04 — MIDI multi-device prioritization, MOCK isolation, hotplug & 0x0E readback', () => {
  it('1. groupWinMmRawPorts filters Wavetable Synth and blank entries, pairs duplex IN/OUT, and prioritizes MG-300 in multi-device setups', () => {
    const ports = groupWinMmRawPorts({
      in: [
        '',
        '   ',
        'Akai MPK Mini IN',
        'Focusrite USB MIDI IN',
        'NUX NME-300 MIDI IN',
        'Microsoft GS Wavetable Synth',
      ],
      out: [
        '   ',
        'Microsoft GS Wavetable Synth',
        'Focusrite USB MIDI OUT',
        'NUX NME-300 MIDI OUT',
      ],
    });

    expect(ports).toHaveLength(3);
    expect(ports.some((p) => p.name.trim() === '')).toBe(false);
    expect(ports.some((p) => p.name.toLowerCase().includes('wavetable'))).toBe(false);
    expect(ports[0]).toEqual({
      id: 'nux-nme-300',
      name: 'NUX NME-300',
      direction: 'duplex',
      isMg300: true,
    });
    expect(ports[1]).toEqual({
      id: 'focusrite-usb',
      name: 'Focusrite USB',
      direction: 'duplex',
      isMg300: false,
    });
    expect(ports[2]).toEqual({
      id: 'akai-mpk-mini',
      name: 'Akai MPK Mini',
      direction: 'in',
      isMg300: false,
    });
  });

  it('2. Explicitly distinguishes MOCK vs hardware adapters and isolates simulated state', async () => {
    const mockAdapter = new MockMidiAdapter();
    const hardwareAdapter = new WinMmMidiAdapter();

    expect(mockAdapter.isMock).toBe(true);
    expect(hardwareAdapter.isMock).toBe(false);

    const mockService = new MidiService(mockAdapter, { autoReconnect: false });
    const hwService = new MidiService(hardwareAdapter, { autoReconnect: false });
    activeServices.push(mockService, hwService);

    expect(mockService.isMockAdapter()).toBe(true);
    expect(mockService.getState().midiAdapterMode).toBe('mock');
    expect(hwService.isMockAdapter()).toBe(false);
    expect(hwService.getState().midiAdapterMode).toBe('hardware');
  });

  it('3. Handles PORT_BUSY, transmission error, hotplug disconnect and auto-reconnect cleanly', async () => {
    const adapter = new MockMidiAdapter();
    const service = new MidiService(adapter, {
      autoReconnect: true,
      reconnectIntervalMs: 40,
    });
    activeServices.push(service);

    adapter.setPortBusy('NUX NME-300', true);
    await expect(service.connect('NUX NME-300')).rejects.toMatchObject({
      code: 'PORT_BUSY',
    });

    adapter.setPortBusy('NUX NME-300', false);
    await service.connect('NUX NME-300');
    expect(service.getState().connectionState).toBe('connected');

    adapter.setFailOnSend(true);
    await expect(service.selectMg300Preset(1)).rejects.toBeInstanceOf(MidiServiceError);
    adapter.setFailOnSend(false);

    adapter.simulateUnexpectedDisconnect('USB unplugged', true);
    expect(service.getState().connectionState).toBe('reconnecting');

    adapter.simulateDeviceReconnected();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && service.getState().connectionState !== 'connected') {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(service.getState().connectionState).toBe('connected');
  });

  it('4. Validates 0x0E User-slot write framing, protects Factory slots, and detects readback mismatches', async () => {
    const adapter = new MockMidiAdapter();
    const service = new MidiService(adapter, {
      autoReconnect: false,
      experimentalEdit: true,
    });
    activeServices.push(service);
    await service.connect('NUX NME-300');

    const safeStruct = sanitizeStruct102ForSysEx(
      buildMg300Struct102({ name: 'S04Verify', patchVolume: 63 }),
    );
    const frame = buildMg300PresetWriteSysEx(safeStruct, 0);
    expect(isExperimentalPresetWriteSysEx(frame)).toBe(true);

    // Factory slot (>= 36) is rejected both at frame builder and at MidiService guard
    expect(() => buildMg300PresetWriteSysEx(safeStruct, 36)).toThrow();
    const forgedFactoryFrame = [...frame];
    forgedFactoryFrame[8] = 36;
    await expect(service.sendExperimentalPresetWrite(forgedFactoryFrame)).rejects.toMatchObject({
      code: 'UNVALIDATED_MESSAGE_BLOCKED',
    });

    await service.sendExperimentalPresetWrite(frame);
    expect(adapter.getSentMessages()).toContainEqual(frame);

    expect(compareStruct102Readback(safeStruct, Uint8Array.from(safeStruct))).toEqual([]);
    const alteredReadback = Uint8Array.from(safeStruct);
    alteredReadback[12] = ((alteredReadback[12] ?? 0) + 5) & 0x7f;
    expect(compareStruct102Readback(safeStruct, alteredReadback)).toContain(12);
  });

  it('5. WinMmMidiAdapter handles graceful stdin close, kill fallback on hung close, and abrupt worker exit without EPIPE crash', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's04-winmm-stub-'));
    tempDirsToClean.push(tempDir);
    const stubPath = path.join(tempDir, 'winmm-worker-stub.mjs');

    fs.writeFileSync(
      stubPath,
      [
        "import fs from 'node:fs';",
        "import readline from 'node:readline';",
        'const mode = process.argv[2];',
        'const scriptPath = process.argv[3] ?? "";',
        'const pidFile = process.argv[4];',
        'if (pidFile) { fs.writeFileSync(pidFile, String(process.pid), "utf8"); }',
        'if (scriptPath.endsWith("list-ports.ps1")) {',
        '  process.stdout.write(JSON.stringify({ in: ["NUX NME-300 MIDI IN"], out: ["NUX NME-300 MIDI OUT"] }) + "\\n");',
        '  process.exit(0);',
        '}',
        'process.stdout.write(JSON.stringify({ event: "opened", portName: "NUX NME-300" }) + "\\n");',
        'if (mode === "abrupt_exit") {',
        '  setTimeout(() => process.exit(1), 50);',
        '}',
        'const rl = readline.createInterface({ input: process.stdin });',
        'rl.on("line", (line) => {',
        '  let msg;',
        '  try { msg = JSON.parse(line); } catch { return; }',
        '  if (msg.cmd === "send") {',
        '    process.stdout.write(JSON.stringify({ event: "ack", id: msg.id, ok: true }) + "\\n");',
        '  } else if (msg.cmd === "close" && mode === "graceful") {',
        '    process.stdout.write(JSON.stringify({ event: "closed" }) + "\\n");',
        '    process.exit(0);',
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );

    // Scenario A: graceful open -> send -> close via stdin
    const gracefulPidFile = path.join(tempDir, 'graceful.pid');
    const gracefulAdapter = new WinMmMidiAdapter({
      powershellExecutable: process.execPath,
      powershellArgsBuilder: (scriptPath) => [stubPath, 'graceful', scriptPath, gracefulPidFile],
      commandTimeoutMs: 5000,
    });
    const ports = await gracefulAdapter.listPorts();
    expect(ports[0]?.name).toBe('NUX NME-300');
    const opened = await gracefulAdapter.openPort('NUX NME-300');
    expect(opened.portName).toBe('NUX NME-300');
    await gracefulAdapter.sendBytes([0xb0, 0x3c, 0x02]);
    await gracefulAdapter.closePort();
    expect(gracefulAdapter.isConnected()).toBe(false);

    // Scenario B: worker hangs on close -> closePort triggers kill() fallback
    const hungPidFile = path.join(tempDir, 'hung.pid');
    const hungAdapter = new WinMmMidiAdapter({
      powershellExecutable: process.execPath,
      powershellArgsBuilder: (scriptPath) => [stubPath, 'hang_on_close', scriptPath, hungPidFile],
      commandTimeoutMs: 5000,
    });
    await hungAdapter.openPort('NUX NME-300');
    const hungPid = Number(fs.readFileSync(hungPidFile, 'utf8').trim());
    expect(isPidAlive(hungPid)).toBe(true);
    await hungAdapter.closePort();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && isPidAlive(hungPid)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(isPidAlive(hungPid)).toBe(false);

    // Scenario C: abrupt worker exit triggers onDisconnect cleanly without EPIPE crash
    const abruptAdapter = new WinMmMidiAdapter({
      powershellExecutable: process.execPath,
      powershellArgsBuilder: (scriptPath) => [stubPath, 'abrupt_exit', scriptPath],
      commandTimeoutMs: 5000,
    });
    let disconnectCount = 0;
    abruptAdapter.onDisconnect(() => {
      disconnectCount += 1;
    });
    await abruptAdapter.openPort('NUX NME-300');
    const discDeadline = Date.now() + 2000;
    while (Date.now() < discDeadline && disconnectCount === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(disconnectCount).toBe(1);
    expect(abruptAdapter.isConnected()).toBe(false);
    await abruptAdapter.closePort();
  }, 10_000);
});
