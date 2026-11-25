import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMg300GlobalStatusQuerySysEx,
  MG300_MIDI_CC,
} from '@quicktone/shared';
import { MidiDiagnosticsLogger } from '../diagnostics-logger.js';
import { MidiService } from '../midi-service.js';
import { MockMidiAdapter } from '../mock-adapter.js';
import { MidiServiceError } from '../types.js';
import {
  normalizeMidiBasePortName,
  WinMmMidiAdapter,
  WinMmSendAckError,
} from '../winmm-adapter.js';

describe('MidiService & MockMidiAdapter', () => {
  let adapter: MockMidiAdapter;
  let service: MidiService;

  beforeEach(() => {
    adapter = new MockMidiAdapter({ autoConfirmHardware: false });
    service = new MidiService(adapter, {
      autoReconnect: true,
      reconnectIntervalMs: 50,
      strictMg300Safety: true,
    });
  });

  afterEach(async () => {
    service.dispose();
    await adapter.closePort();
    vi.useRealTimers();
  });

  describe('1. Conexão e Descoberta de Dispositivos', () => {
    it('auto-detects and connects to NUX NME-300 when portName is omitted', async () => {
      const ports = await service.discoverPorts();
      expect(ports).toHaveLength(1);
      expect(ports[0]?.name).toBe('NUX NME-300');
      expect(ports[0]?.isMg300).toBe(true);

      await service.connect();
      const state = service.getState();
      expect(state.connectionState).toBe('connected');
      expect(state.connectedPortName).toBe('NUX NME-300');
      expect(state.syncStatus).toBe('unknown');
      expect(state.lastError).toBeNull();
    });

    it('connects explicitly by port name', async () => {
      await service.connect('NUX NME-300');
      expect(service.getState().connectionState).toBe('connected');
      expect(service.getState().connectedPortName).toBe('NUX NME-300');
    });

    it('throws DEVICE_NOT_FOUND when no MG-300 device is available', async () => {
      adapter.setPorts([
        {
          id: 'other-midi',
          name: 'Generic USB Keyboard',
          direction: 'duplex',
          isMg300: false,
        },
      ]);

      await expect(service.connect()).rejects.toMatchObject({
        name: 'MidiServiceError',
        code: 'DEVICE_NOT_FOUND',
      });

      const state = service.getState();
      expect(state.connectionState).toBe('error');
      expect(state.connectedPortName).toBeNull();
      expect(state.lastError?.code).toBe('DEVICE_NOT_FOUND');
    });

    it('throws DEVICE_NOT_FOUND when requesting a non-existent explicit port', async () => {
      await expect(service.connect('NonExistent MIDI Port')).rejects.toMatchObject({
        code: 'DEVICE_NOT_FOUND',
      });
      expect(service.getState().connectionState).toBe('error');
    });
  });

  describe('2. Desconexão e Limpeza de Estado', () => {
    it('resets connectionState to disconnected and syncStatus to unknown upon disconnect', async () => {
      await service.connect();
      await service.selectMg300Preset(0);
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.PRESET_SELECT, 0]);
      expect(service.getState().syncStatus).toBe('confirmed');

      await service.disconnect();
      const state = service.getState();
      expect(state.connectionState).toBe('disconnected');
      expect(state.connectedPortName).toBeNull();
      expect(state.syncStatus).toBe('unknown');
      expect(state.confirmedState.presetId).toBeNull();
      expect(state.confirmedState.slotIndex).toBeNull();
    });

    it('rejects MIDI commands with DISCONNECTED when not connected', async () => {
      await expect(service.selectMg300Preset(0)).rejects.toMatchObject({
        code: 'DISCONNECTED',
      });
      await expect(service.setVolume(50)).rejects.toMatchObject({
        code: 'DISCONNECTED',
      });
      await expect(service.sendProgramChange(1)).rejects.toMatchObject({
        code: 'DISCONNECTED',
      });
    });
  });

  describe('3. Porta Ocupada (PORT_BUSY)', () => {
    it('throws PORT_BUSY when the MG-300 port is locked by another process', async () => {
      adapter.setPortBusy('NUX NME-300', true);

      await expect(service.connect('NUX NME-300')).rejects.toMatchObject({
        name: 'MidiServiceError',
        code: 'PORT_BUSY',
      });

      const state = service.getState();
      expect(state.connectionState).toBe('error');
      expect(state.connectedPortName).toBeNull();
      expect(state.lastError?.code).toBe('PORT_BUSY');
    });
  });

  describe('4. Program Change e Preset Select Nativo MG-300 (CC 0x3C)', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('sends MG-300 native CC 0x3C (60) for User preset 1A (slot 0) and Factory preset F1D (slot 39)', async () => {
      const cmdUser = await service.selectMg300Preset(0);
      expect(cmdUser.presetId).toBe('1A');
      expect(cmdUser.slotIndex).toBe(0);
      expect(cmdUser.midiBytes).toEqual([0xb0, 0x3c, 0x00]);

      const cmdFactory = await service.selectMg300Preset(39);
      expect(cmdFactory.presetId).toBe('F1D');
      expect(cmdFactory.slotIndex).toBe(39);
      expect(cmdFactory.midiBytes).toEqual([0xb0, 0x3c, 39]);

      expect(adapter.getSentMessages()).toEqual([
        [0xb0, 0x3c, 0],
        [0xb0, 0x3c, 39],
      ]);
    });

    it('sends standard MIDI Program Change (0xC0 | ch, program)', async () => {
      const cmd = await service.sendProgramChange(15, 2);
      expect(cmd.type).toBe('program_change');
      expect(cmd.slotIndex).toBe(15);
      expect(cmd.midiBytes).toEqual([0xc2, 15]);
      expect(adapter.getSentMessages()).toEqual([[0xc2, 15]]);
    });

    it('supports selectPresetByMapping for both mg300-cc60 and standard-pc protocols', async () => {
      await service.selectPresetByMapping({
        id: 'F2A',
        slotIndex: 40,
        midiMapping: {
          protocol: 'mg300-cc60',
          channel: 0,
          ccNumber: 0x3c,
          ccValue: 40,
        },
      });

      await service.selectPresetByMapping({
        id: '1B',
        slotIndex: 1,
        midiMapping: {
          protocol: 'standard-pc',
          channel: 1,
          bankMsb: 0,
          bankLsb: 2,
          programNumber: 5,
        },
      });

      expect(adapter.getSentMessages()).toEqual([
        [0xb0, 0x3c, 40],
        [0xb1, 0x00, 0],
        [0xb1, 0x20, 2],
        [0xc1, 5],
      ]);
    });
  });

  describe('5. Bank Select (MSB CC 0x00 e LSB CC 0x20)', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('transmits Bank Select MSB (CC 0) followed by LSB (CC 32)', async () => {
      const record = await service.sendBankSelect(2, 7, 3);
      expect(record.type).toBe('bank_select');
      expect(record.midiBytes).toEqual([0xb3, 0x00, 2, 0xb3, 0x20, 7]);
      expect(adapter.getSentMessages()).toEqual([
        [0xb3, 0x00, 2],
        [0xb3, 0x20, 7],
      ]);
    });
  });

  describe('6. Control Change de Volume e Proteção Contra CC 7 na MG-300', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('transmits CC 0x40 (64) exclusively for master_cc64 and rejects patch_cc74 / expression_cc61', async () => {
      const masterCmd = await service.setVolume(80, 'master_cc64');
      expect(masterCmd.midiBytes).toEqual([0xb0, 0x40, 80]);
      expect(masterCmd.volumeTarget).toBe('master_cc64');

      await expect(service.setVolume(65, 'patch_cc74')).rejects.toMatchObject({
        name: 'MidiServiceError',
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(service.setVolume(100, 'expression_cc61')).rejects.toMatchObject({
        name: 'MidiServiceError',
        code: 'INVALID_MIDI_VALUE',
      });
      expect(() => service.setVolumeTarget('patch_cc74')).toThrow(MidiServiceError);

      // Incoming CC 74 / CC 61 must NOT overwrite confirmed Master Volume
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.MASTER_VOLUME, 80]);
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.PATCH_LEVEL, 42]);
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.EXPRESSION_PEDAL, 15]);
      expect(service.getState().confirmedState.volume).toBe(80);
      expect(service.getState().confirmedState.volumeTarget).toBe('master_cc64');

      expect(adapter.getSentMessages()).toEqual([[0xb0, 0x40, 80]]);
    });

    it('deduplicates concurrent connect() attempts without opening multiple sessions', async () => {
      await service.disconnect();
      const openSpy = vi.spyOn(adapter, 'openPort');
      await Promise.all([
        service.connect('NUX NME-300'),
        service.connect('NUX NME-300'),
        service.connect('NUX NME-300'),
      ]);
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(service.getState().connectionState).toBe('connected');
    });

    it('blocks standard MIDI CC 7 (which overwrites Delay block on NUX MG-300) and any unvalidated CC', async () => {
      await expect(service.sendControlChange(7, 100)).rejects.toMatchObject({
        name: 'MidiServiceError',
        code: 'UNVALIDATED_MESSAGE_BLOCKED',
      });

      for (let effectCc = 1; effectCc <= 10; effectCc++) {
        await expect(service.sendControlChange(effectCc, 1)).rejects.toMatchObject({
          code: 'UNVALIDATED_MESSAGE_BLOCKED',
        });
      }

      await expect(service.sendControlChange(99, 64)).rejects.toMatchObject({
        code: 'UNVALIDATED_MESSAGE_BLOCKED',
      });

      // Zero unvalidated bytes may ever reach the hardware adapter
      expect(adapter.getSentMessages()).toHaveLength(0);
    });
  });

  describe('7. Validação Estrita de Valores Inválidos (INVALID_MIDI_VALUE)', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('rejects out-of-range or non-integer preset slots, programs, volumes, banks, and channels', async () => {
      // MG-300 preset slots must be integer 0..71
      await expect(service.selectMg300Preset(-1)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(service.selectMg300Preset(72)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(service.selectMg300Preset(3.5)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(service.selectMg300Preset(Number.NaN)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });

      // MG-300 volume must be integer 0..100
      await expect(service.setVolume(-1)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(service.setVolume(101)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(service.setVolume(50.25)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });

      // Program Change must be integer 0..127
      await expect(service.sendProgramChange(-1)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(service.sendProgramChange(128)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });

      // Bank Select MSB/LSB must be integer 0..127
      await expect(service.sendBankSelect(-1, 0)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(service.sendBankSelect(0, 128)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });

      // MIDI channel must be integer 0..15
      await expect(service.selectMg300Preset(0, -1)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(service.selectMg300Preset(0, 16)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });

      expect(adapter.getSentMessages()).toHaveLength(0);
    });
  });

  describe('8. Recuperação Automática Após Desconexão Inesperada', () => {
    it('transitions to reconnecting on unexpected USB disconnect and reconnects when device returns', async () => {
      vi.useFakeTimers();
      await service.connect();
      expect(service.getState().connectionState).toBe('connected');

      // Simulate USB cable unplugged and port temporarily disappearing
      adapter.simulateUnexpectedDisconnect('USB cable unplugged', true);

      const afterDrop = service.getState();
      expect(afterDrop.connectionState).toBe('reconnecting');
      expect(afterDrop.connectedPortName).toBeNull();
      expect(afterDrop.syncStatus).toBe('unknown');
      expect(afterDrop.lastError?.code).toBe('DISCONNECTED');

      // Advance timer while device is still unplugged: remains reconnecting
      await vi.advanceTimersByTimeAsync(60);
      expect(service.getState().connectionState).toBe('reconnecting');

      // Simulate device plugged back into USB
      adapter.simulateDeviceReconnected();
      await vi.advanceTimersByTimeAsync(60);

      const recovered = service.getState();
      expect(recovered.connectionState).toBe('connected');
      expect(recovered.connectedPortName).toBe('NUX NME-300');
      expect(recovered.lastError).toBeNull();

      // Verify MIDI communication works after automatic reconnection
      const cmd = await service.selectMg300Preset(4);
      expect(cmd.presetId).toBe('2A');
      expect(adapter.getSentMessages()).toContainEqual([0xb0, 0x3c, 4]);
    });
  });

  describe('9. Modelo Tri-State Rigoroso (Confirmed vs Command Sent Unconfirmed vs Unknown)', () => {
    it('never marks a sent command as confirmed until actual MIDI IN arrives from hardware', async () => {
      await service.connect();

      // 1. Initial state after connection: 'unknown'
      const initial = service.getState();
      expect(initial.syncStatus).toBe('unknown');
      expect(initial.confirmedState.presetId).toBeNull();
      expect(initial.confirmedState.slotIndex).toBeNull();
      expect(initial.confirmedState.volume).toBeNull();
      expect(initial.lastSentCommand).toBeNull();

      // 2. Send preset change to 2B (slot 5) via MIDI OUT
      await service.selectMg300Preset(5);
      const afterSend = service.getState();
      expect(afterSend.syncStatus).toBe('command_sent_unconfirmed');
      expect(afterSend.lastSentCommand).not.toBeNull();
      expect(afterSend.lastSentCommand?.presetId).toBe('2B');
      expect(afterSend.lastSentCommand?.slotIndex).toBe(5);
      expect(afterSend.lastSentCommand?.confirmedByDevice).toBe(false);
      // Confirmed state MUST remain null because hardware has not echoed/confirmed via MIDI IN!
      expect(afterSend.confirmedState.presetId).toBeNull();
      expect(afterSend.confirmedState.slotIndex).toBeNull();
      expect(afterSend.confirmedState.confirmedAt).toBeNull();

      // 3. Hardware confirms preset 2B via MIDI IN: [0xB0, 0x3C, 5]
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.PRESET_SELECT, 5]);
      const afterConfirm = service.getState();
      expect(afterConfirm.syncStatus).toBe('confirmed');
      expect(afterConfirm.confirmedState.presetId).toBe('2B');
      expect(afterConfirm.confirmedState.slotIndex).toBe(5);
      expect(afterConfirm.confirmedState.confirmedAt).not.toBeNull();
      expect(afterConfirm.lastSentCommand?.confirmedByDevice).toBe(true);

      // 4. Send volume change (72) while previous preset was confirmed
      await service.setVolume(72, 'master_cc64');
      const afterVolSend = service.getState();
      expect(afterVolSend.syncStatus).toBe('command_sent_unconfirmed');
      expect(afterVolSend.lastSentCommand?.volume).toBe(72);
      expect(afterVolSend.lastSentCommand?.confirmedByDevice).toBe(false);
      // Confirmed volume is still null until hardware confirms, while previous confirmed preset remains '2B'
      expect(afterVolSend.confirmedState.presetId).toBe('2B');
      expect(afterVolSend.confirmedState.volume).toBeNull();

      // 5. Hardware confirms volume via MIDI IN: [0xB0, 0x40, 72]
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.MASTER_VOLUME, 72]);
      const afterVolConfirm = service.getState();
      expect(afterVolConfirm.syncStatus).toBe('confirmed');
      expect(afterVolConfirm.confirmedState.volume).toBe(72);
      expect(afterVolConfirm.confirmedState.volumeTarget).toBe('master_cc64');
      expect(afterVolConfirm.lastSentCommand?.confirmedByDevice).toBe(true);
    });

    it('rolls back lastSentCommand and records TRANSMISSION_FAILED if adapter.sendBytes fails', async () => {
      await service.connect();
      adapter.setFailOnSend(true);

      await expect(service.selectMg300Preset(0)).rejects.toBeInstanceOf(MidiServiceError);

      const state = service.getState();
      expect(state.lastSentCommand).toBeNull();
      expect(state.syncStatus).toBe('unknown');
      expect(state.lastError?.code).toBe('TRANSMISSION_FAILED');
    });
  });

  describe('10. Read-Only SysEx Queries & WinMM Duplex Pairing', () => {
    it('normalizes WinMM MIDI IN/OUT endpoint suffixes to a shared base device name', () => {
      expect(normalizeMidiBasePortName('NUX NME-300 MIDI IN')).toBe('NUX NME-300');
      expect(normalizeMidiBasePortName('NUX NME-300 MIDI OUT')).toBe('NUX NME-300');
      expect(normalizeMidiBasePortName('Focusrite USB MIDI IN 2')).toBe('Focusrite USB');
      expect(normalizeMidiBasePortName('NUX NME-300')).toBe('NUX NME-300');
    });

    it('blocks unsafe write SysEx frames and processes 0x10/0x18/0x06 inbound SysEx replies', async () => {
      await service.connect();

      await expect(
        service.sendReadOnlySysEx([0xf0, 0x00, 0x11, 0x22, 0x66, 0x00, 0x70, 0x02, 0xf7]),
      ).rejects.toMatchObject({ code: 'UNVALIDATED_MESSAGE_BLOCKED' });

      await service.queryGlobalStatus();
      expect(adapter.getSentMessages()).toContainEqual(buildMg300GlobalStatusQuerySysEx());

      const dumpedSlots: number[] = [];
      service.onPresetDump(({ slotIndex }) => dumpedSlots.push(slotIndex));

      // Identity reply (0x10)
      const idBytes = new Array<number>(48).fill(0);
      idBytes[0] = 0xf0;
      idBytes[1] = 0x00;
      idBytes[2] = 0x11;
      idBytes[3] = 0x22;
      idBytes[4] = 0x66;
      idBytes[5] = 0x00;
      idBytes[6] = 0x10;
      'V01_20191106'.split('').forEach((c, idx) => {
        idBytes[7 + idx] = c.charCodeAt(0);
      });
      'NUX_MG1X'.split('').forEach((c, idx) => {
        idBytes[39 + idx] = c.charCodeAt(0);
      });
      idBytes[47] = 0xf7;
      adapter.simulateHardwareIncoming(idBytes);

      // Global status reply (0x18) -> slot 8 (3A), master 62%
      adapter.simulateHardwareIncoming([
        0xf0, 0x00, 0x11, 0x22, 0x66, 0x00, 0x70, 0x18, 0x00, 8, 0, 62, 3, 0, 50, 50, 0xf7,
      ]);

      const state = service.getState();
      expect(state.deviceFirmwareVersion).toBe('NUX_MG1X · V01_20191106');
      expect(state.syncStatus).toBe('confirmed');
      expect(state.confirmedState.slotIndex).toBe(8);
      expect(state.confirmedState.presetId).toBe('3A');
      expect(state.confirmedState.volume).toBe(62);
      expect(state.confirmedState.volumeTarget).toBe('master_cc64');

      // 113B Preset dump (0x06) for slot 8
      const dump = new Array<number>(113).fill(0);
      dump[0] = 0xf0;
      dump[1] = 0x00;
      dump[2] = 0x11;
      dump[3] = 0x22;
      dump[4] = 0x66;
      dump[5] = 0x00;
      dump[6] = 0x70;
      dump[7] = 0x06;
      dump[8] = 8;
      dump[111] = 55;
      dump[112] = 0xf7;
      adapter.simulateHardwareIncoming(dump);
      expect(dumpedSlots).toEqual([8]);

      await service.selectMg300Preset(8);
      await service.disconnect();
      const disconnectedState = service.getState();
      expect(disconnectedState.connectionState).toBe('disconnected');
      expect(disconnectedState.deviceFirmwareVersion).toBeNull();
      expect(disconnectedState.lastSentCommand).toBeNull();
    });

    it('clears lastSentCommand on unexpected disconnect and preserves pending status when mismatched MIDI IN arrives', async () => {
      await service.connect();
      await service.selectMg300Preset(2); // 1C pending
      expect(service.getState().syncStatus).toBe('command_sent_unconfirmed');
      expect(service.getState().lastSentCommand?.presetId).toBe('1C');

      // Unexpected USB unplug clears pending lastSentCommand
      adapter.simulateUnexpectedDisconnect('USB unplugged', true);
      expect(service.getState().syncStatus).toBe('unknown');
      expect(service.getState().lastSentCommand).toBeNull();

      // Reconnect and verify pending volume_change stays unconfirmed if pedal reports CC 60
      adapter.simulateDeviceReconnected();
      await service.connect();
      await service.setVolume(65, 'master_cc64');
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.PRESET_SELECT, 4]);
      expect(service.getState().confirmedState.presetId).toBe('2A');
      expect(service.getState().syncStatus).toBe('command_sent_unconfirmed');

      // Hardware switches directly to another preset (5 -> 2B) superseding pending 1B (1)
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.MASTER_VOLUME, 65]);
      await service.selectMg300Preset(1);
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.PRESET_SELECT, 5]);
      expect(service.getState().confirmedState.presetId).toBe('2B');
      expect(service.getState().lastSentCommand).toBeNull();
      expect(service.getState().syncStatus).toBe('confirmed');

      // Hardware physical knob turns Master Volume to 42 overriding pending 80
      await service.setVolume(80, 'master_cc64');
      expect(service.getState().syncStatus).toBe('command_sent_unconfirmed');
      adapter.simulateHardwareIncoming([0xb0, MG300_MIDI_CC.MASTER_VOLUME, 42]);
      expect(service.getState().confirmedState.volume).toBe(42);
      expect(service.getState().lastSentCommand).toBeNull();
      expect(service.getState().syncStatus).toBe('confirmed');
    });
  });

  describe('11. Experimental Real-Time Editing CCs', () => {
    it('allows CC 1..59, 71, 74 with exact range checks and blocks CC 70 when experimentalEdit is enabled', async () => {
      const expService = new MidiService(adapter, {
        strictMg300Safety: true,
        experimentalEdit: true,
      });
      await expService.connect();

      await expService.sendExperimentalControlChange(23, 75);
      await expService.sendExperimentalControlChange(47, 60);
      await expService.sendExperimentalControlChange(59, 2);
      await expService.sendExperimentalControlChange(71, 40);
      await expService.sendExperimentalControlChange(74, 85);

      expect(adapter.getSentMessages()).toEqual([
        [0xb0, 23, 75],
        [0xb0, 47, 60],
        [0xb0, 59, 2],
        [0xb0, 71, 40],
        [0xb0, 74, 85],
      ]);

      await expect(expService.sendExperimentalControlChange(70, 1)).rejects.toMatchObject({
        code: 'UNVALIDATED_MESSAGE_BLOCKED',
      });
      await expect(expService.sendExperimentalControlChange(64, 50)).rejects.toMatchObject({
        code: 'UNVALIDATED_MESSAGE_BLOCKED',
      });
      await expect(expService.sendExperimentalControlChange(60, 1)).rejects.toMatchObject({
        code: 'UNVALIDATED_MESSAGE_BLOCKED',
      });
      await expect(expService.sendExperimentalControlChange(59, 3)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(expService.sendExperimentalControlChange(71, 41)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });

      adapter.setFailOnSend(true);
      await expect(expService.sendExperimentalControlChange(23, 50)).rejects.toMatchObject({
        code: 'TRANSMISSION_FAILED',
      });
      expect(expService.getState().lastError?.code).toBe('TRANSMISSION_FAILED');

      expService.dispose();
    });

    it('validates block model IDs on CC 1..10 (allowing CAB=100 User IR, rejecting invalid models) and restricts 0x0E writes to User slots 0..35', async () => {
      const { buildMg300PresetWriteSysEx, createBlankMg300Struct102 } = await import(
        '@quicktone/shared'
      );
      const expService = new MidiService(adapter, {
        strictMg300Safety: true,
        experimentalEdit: true,
      });
      await expService.connect();

      await expService.sendExperimentalControlChange(2, 12); // EFX Pitch Bender
      await expService.sendExperimentalControlChange(3, 27); // AMP MLD
      await expService.sendExperimentalControlChange(9, 100); // CAB User IR
      await expService.sendExperimentalControlChange(10, 4); // MIC Cond C414
      expect(adapter.getSentMessages()).toEqual([
        [0xb0, 2, 12],
        [0xb0, 3, 27],
        [0xb0, 9, 100],
        [0xb0, 10, 4],
      ]);

      await expect(expService.sendExperimentalControlChange(3, 28)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(expService.sendExperimentalControlChange(9, 55)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });
      await expect(expService.sendExperimentalControlChange(10, 5)).rejects.toMatchObject({
        code: 'INVALID_MIDI_VALUE',
      });

      const draft = createBlankMg300Struct102({ name: 'Test 0E' });
      const frame1A = buildMg300PresetWriteSysEx(draft, 0);
      const frame9D = buildMg300PresetWriteSysEx(draft, 35);
      await expService.sendExperimentalPresetWrite(frame1A);
      await expService.sendExperimentalPresetWrite(frame9D);

      // Tamper target slot byte to Factory F1A (36) and F9D (71) -> blocked
      const factoryFrame = [...frame1A];
      factoryFrame[8] = 36;
      await expect(expService.sendExperimentalPresetWrite(factoryFrame)).rejects.toMatchObject({
        code: 'UNVALIDATED_MESSAGE_BLOCKED',
      });
      factoryFrame[8] = 71;
      await expect(expService.sendExperimentalPresetWrite(factoryFrame)).rejects.toMatchObject({
        code: 'UNVALIDATED_MESSAGE_BLOCKED',
      });

      expService.dispose();
    });
  });

  describe('12. Log de Diagnóstico e Auto-Recuperação WinMM em mmresult=1', () => {
    it('writes structured diagnostic entries and rotates log file when exceeding maxBytes', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-log-test-'));
      try {
        const logFile = path.join(tmpDir, 'midi-diagnostics.log');
        const logger = new MidiDiagnosticsLogger({
          logFilePath: logFile,
          maxBytes: 80,
          enabled: true,
        });

        logger.info('winmm', 'First entry\nwith multiline stderr', { mmresult: 1, op: 'midiOutLongMsg' });
        logger.error('winmm', 'Second entry triggering rotation', { mmresult: 1, op: 'midiOutShortMsg' });

        const current = fs.readFileSync(logFile, 'utf8');
        const rotated = path.join(tmpDir, 'midi-diagnostics.prev.log');
        expect(current).toContain('[ERROR] [winmm] Second entry triggering rotation');
        expect(fs.existsSync(rotated)).toBe(true);
        const rotatedContent = fs.readFileSync(rotated, 'utf8');
        expect(rotatedContent).toContain('First entry \\n with multiline stderr');
        expect(rotatedContent.trim().split('\n')).toHaveLength(1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('recovers once on mmresult=1 stall and disconnects with user-friendly message when retry fails', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-winmm-recover-'));
      try {
        const logFile = path.join(tmpDir, 'midi-diagnostics.log');
        const logger = new MidiDiagnosticsLogger({ logFilePath: logFile, enabled: true });
        const winmm = new WinMmMidiAdapter({ logger });

        let sendAttempts = 0;
        let openCalls = 0;
        let closeCalls = 0;
        const disconnectReasons: Array<string | undefined> = [];
        winmm.onDisconnect((reason) => disconnectReasons.push(reason));

        const internals = winmm as unknown as {
          worker: object | null;
          connectedPortName: string | null;
          sendBytesOnce: (bytes: number[]) => Promise<void>;
        };
        internals.worker = {};
        internals.connectedPortName = 'NUX NME-300';

        vi.spyOn(winmm, 'closePort').mockImplementation(async () => {
          closeCalls += 1;
          internals.worker = null;
          internals.connectedPortName = null;
        });
        vi.spyOn(winmm, 'openPort').mockImplementation(async (portName: string) => {
          openCalls += 1;
          internals.worker = {};
          internals.connectedPortName = portName;
          return { portName };
        });

        // Case 1: first send hits mmresult=1 -> closes, reopens once, retry succeeds
        const sendOnceSpy = vi.spyOn(internals, 'sendBytesOnce').mockImplementation(async () => {
          sendAttempts += 1;
          if (sendAttempts === 1) {
            throw new WinMmSendAckError(1, 'midiOutLongMsg');
          }
        });

        await winmm.sendBytes([0xf0, 0x00, 0x11, 0x22, 0x66, 0x00, 0x00, 0xf7]);
        expect(closeCalls).toBe(1);
        expect(openCalls).toBe(1);
        expect(sendAttempts).toBe(2);
        expect(disconnectReasons).toHaveLength(0);

        // Case 2: persistent mmresult=1 even after reconnect -> forces disconnect and throws user-friendly error
        sendOnceSpy.mockImplementation(async () => {
          throw new WinMmSendAckError(1, 'midiOutShortMsg');
        });

        try {
          await winmm.sendBytes([0xb0, 0x3c, 15]);
          expect.unreachable('Expected TRANSMISSION_FAILED');
        } catch (err) {
          expect(err).toBeInstanceOf(MidiServiceError);
          const midiErr = err as MidiServiceError;
          expect(midiErr.code).toBe('TRANSMISSION_FAILED');
          expect(midiErr.message).not.toMatch(/WinMM|mmresult|MMSYSERR|MidiSrv/i);
        }

        expect(closeCalls).toBe(3);
        expect(openCalls).toBe(2);
        expect(winmm.isConnected()).toBe(false);
        expect(disconnectReasons).toHaveLength(1);
        expect(disconnectReasons[0]).not.toMatch(/WinMM|mmresult|MidiSrv/i);

        const logContent = fs.readFileSync(logFile, 'utf8');
        expect(logContent).toContain('mmresult=1');
        expect(logContent).toContain('midiOutLongMsg');
        expect(logContent).toContain('midiOutShortMsg');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('preserves tri-state (unknown/null) and stall disconnect message in MidiService, and queues concurrent sends during recovery', async () => {
      const winmm = new WinMmMidiAdapter({
        logger: new MidiDiagnosticsLogger({ logFilePath: null }),
      });

      const internals = winmm as unknown as {
        worker: object | null;
        connectedPortName: string | null;
        sendBytesOnce: (bytes: number[]) => Promise<void>;
      };

      vi.spyOn(winmm, 'listPorts').mockResolvedValue([
        { id: 'nux-nme-300', name: 'NUX NME-300', direction: 'duplex', isMg300: true },
      ]);
      vi.spyOn(winmm, 'closePort').mockImplementation(async () => {
        internals.worker = null;
        internals.connectedPortName = null;
      });
      let openDelayMs = 0;
      vi.spyOn(winmm, 'openPort').mockImplementation(async (portName: string) => {
        if (openDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, openDelayMs));
        }
        internals.worker = {};
        internals.connectedPortName = portName;
        return { portName };
      });

      const integratedService = new MidiService(winmm, {
        autoReconnect: true,
        reconnectIntervalMs: 60_000,
        logger: new MidiDiagnosticsLogger({ logFilePath: null }),
      });

      try {
        await integratedService.connect('NUX NME-300');

        // 1. Concurrent send during recovery waits instead of failing with DISCONNECTED
        let firstCall = true;
        openDelayMs = 40;
        const sendOnceSpy = vi.spyOn(internals, 'sendBytesOnce').mockImplementation(async () => {
          if (firstCall) {
            firstCall = false;
            throw new WinMmSendAckError(1, 'midiOutShortMsg');
          }
        });

        const p1 = integratedService.selectMg300Preset(0);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(winmm.isConnected()).toBe(true);
        const p2 = integratedService.setVolume(55, 'master_cc64');
        await Promise.all([p1, p2]);

        // Confirm state via MIDI IN
        const rx = (winmm as unknown as { incomingListeners: Set<(b: number[]) => void> })
          .incomingListeners;
        for (const fn of rx) {
          fn([0xb0, MG300_MIDI_CC.PRESET_SELECT, 0]);
          fn([0xb0, MG300_MIDI_CC.MASTER_VOLUME, 55]);
        }
        expect(integratedService.getState().syncStatus).toBe('confirmed');

        // 2. Persistent stall forces clean disconnect without corrupting tri-state or overwriting stall lastError
        openDelayMs = 0;
        sendOnceSpy.mockImplementation(async () => {
          throw new WinMmSendAckError(1, 'midiOutShortMsg');
        });

        await expect(integratedService.selectMg300Preset(15)).rejects.toMatchObject({
          code: 'TRANSMISSION_FAILED',
        });

        const afterStall = integratedService.getState();
        expect(afterStall.connectionState).toBe('reconnecting');
        expect(afterStall.syncStatus).toBe('unknown');
        expect(afterStall.lastSentCommand).toBeNull();
        expect(afterStall.confirmedState.presetId).toBeNull();
        expect(afterStall.lastError?.code).toBe('DISCONNECTED');
        expect(afterStall.lastError?.message).toMatch(/parou de responder/i);
      } finally {
        integratedService.dispose();
      }
    });
  });
});
