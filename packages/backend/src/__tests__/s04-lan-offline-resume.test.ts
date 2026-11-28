import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { ControllerStateSchema } from '@quicktone/shared';
import { MockMidiAdapter, WinMmMidiAdapter } from '@quicktone/midi';
import {
  ControllerStateManager,
  createBackendApp,
  getLocalLanAddresses,
  resolveMidiAdapterSelection,
  selectPrioritizedLanAddresses,
} from '../index.js';

function makeNic(
  address: string,
  internal = false,
  family: 'IPv4' | 'IPv6' = 'IPv4',
): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::',
    family,
    mac: '00:11:22:33:44:55',
    internal,
    cidr: family === 'IPv4' ? `${address}/24` : `${address}/64`,
  } as os.NetworkInterfaceInfo;
}

describe('S04 — Smart LAN discovery, packaged MOCK guard & sleep/resume recovery', () => {
  it('1. selectPrioritizedLanAddresses excludes APIPA/loopback and prefers physical Wi-Fi over WSL/Docker virtual NICs', () => {
    const selected = selectPrioritizedLanAddresses({
      'Loopback Pseudo-Interface 1': [makeNic('127.0.0.1', true)],
      'vEthernet (WSL)': [makeNic('172.24.80.1')],
      'Ethernet (VMware Network Adapter VMnet8)': [makeNic('192.168.159.1')],
      'Wi-Fi Link-Local': [makeNic('169.254.44.12')],
      'Ethernet (DockerNAT)': [makeNic('10.0.75.1')],
      'Wi-Fi': [makeNic('10.10.0.15'), makeNic('192.168.1.42')],
      'Wi-Fi v6': [makeNic('fe80::1', false, 'IPv6')],
    });

    expect(selected).toEqual(['192.168.1.42', '10.10.0.15']);

    // Falls back to non-APIPA virtual NICs when no physical NIC is connected
    const fallbackVirtual = selectPrioritizedLanAddresses({
      'Wi-Fi': [makeNic('169.254.11.2')],
      'vEthernet (WSL)': [makeNic('172.28.1.1')],
    });
    expect(fallbackVirtual).toEqual(['172.28.1.1']);
    expect(Array.isArray(getLocalLanAddresses())).toBe(true);
  });

  it('2. resolveMidiAdapterSelection blocks QUICKTONE_MIDI_ADAPTER=mock in packaged builds unless explicitly allowed', () => {
    expect(
      resolveMidiAdapterSelection({
        envAdapter: 'mock',
        isPackaged: true,
        allowPackagedMock: false,
      }),
    ).toEqual({
      useMock: false,
      blockedPackagedMock: true,
    });

    expect(
      resolveMidiAdapterSelection({
        envAdapter: 'mock',
        isPackaged: true,
        allowPackagedMock: true,
      }),
    ).toEqual({
      useMock: true,
      blockedPackagedMock: false,
    });

    expect(
      resolveMidiAdapterSelection({
        envAdapter: 'mock',
        isPackaged: false,
      }),
    ).toEqual({
      useMock: true,
      blockedPackagedMock: false,
    });

    expect(
      resolveMidiAdapterSelection({
        explicitAdapter: new WinMmMidiAdapter(),
        envAdapter: 'mock',
        isPackaged: true,
      }),
    ).toEqual({
      useMock: false,
      blockedPackagedMock: false,
    });
  });

  it('3. Preserves offline LAN mobile<->PC pairing & handles desktop-only POST /api/system/resume cleanly', async () => {
    const mockAdapter = new MockMidiAdapter({ autoConfirmHardware: true });
    const app = createBackendApp({
      midiAdapter: mockAdapter,
      autoConnectMidiOnInit: true,
      includeFactoryPresets: true,
      fillMissingUserSlots: true,
      enableSysExSync: false,
      experimentalEdit: false,
    });

    try {
      await app.ready();

      const statusRes = await app.inject({ method: 'GET', url: '/api/status' });
      expect(statusRes.statusCode).toBe(200);
      const parsedStatus = ControllerStateSchema.parse(statusRes.json());
      expect(parsedStatus.midiAdapterMode).toBe('mock');

      // Desktop creates temporary QR pairing challenge (localhost works completely offline)
      const challengeRes = await app.inject({ method: 'POST', url: '/api/pairing/challenge' });
      expect(challengeRes.statusCode).toBe(200);
      const challengeBody = challengeRes.json() as { challenge: { pairingCode: string } };

      // Remote mobile client requests pairing (simulated LAN IP 192.168.1.77 via X-Forwarded-For on loopback)
      const mobileHeaders = { 'x-forwarded-for': '192.168.1.77', host: '127.0.0.1:3001' };
      const reqRes = await app.inject({
        method: 'POST',
        url: '/api/pairing/request',
        headers: mobileHeaders,
        payload: {
          pairingCode: challengeBody.challenge.pairingCode,
          deviceName: 'Celular S04 Offline',
        },
      });
      expect(reqRes.statusCode).toBe(200);
      const reqBody = reqRes.json() as { requestId: string; claimSecret: string };

      const approveRes = await app.inject({
        method: 'POST',
        url: '/api/pairing/approve',
        payload: { requestId: reqBody.requestId },
      });
      expect(approveRes.statusCode).toBe(200);

      const pollRes = await app.inject({
        method: 'POST',
        url: '/api/pairing/poll',
        headers: mobileHeaders,
        payload: {
          requestId: reqBody.requestId,
          claimSecret: reqBody.claimSecret,
        },
      });
      expect(pollRes.statusCode).toBe(200);
      const setCookies = pollRes.headers['set-cookie'];
      const cookieHeader = Array.isArray(setCookies) ? setCookies.join('; ') : String(setCookies ?? '');
      expect(cookieHeader).toContain('mg300_session=');

      // Mobile adjusts preset and volume offline
      const selectRes = await app.inject({
        method: 'POST',
        url: '/api/presets/select',
        headers: { ...mobileHeaders, cookie: cookieHeader },
        payload: { slotIndex: 2 },
      });
      expect(selectRes.statusCode).toBe(200);
      expect(selectRes.json().state.confirmedState.slotIndex).toBe(2);

      // Remote mobile must NOT be able to invoke desktop-only /api/system/resume
      const forbiddenResume = await app.inject({
        method: 'POST',
        url: '/api/system/resume',
        headers: { ...mobileHeaders, cookie: cookieHeader },
      });
      expect(forbiddenResume.statusCode).toBe(403);
      expect(forbiddenResume.json().code).toBe('DESKTOP_ONLY');

      // Simulate unexpected MIDI disconnect before Windows sleep/resume
      mockAdapter.simulateUnexpectedDisconnect('Sleep suspend USB', true);
      expect(app.stateManager.getState().connectionState).not.toBe('connected');

      // Desktop /api/system/resume refreshes LAN URLs, reconnects MIDI, and preserves active mobile session
      mockAdapter.simulateDeviceReconnected();
      const resumeRes = await app.inject({ method: 'POST', url: '/api/system/resume' });
      expect(resumeRes.statusCode).toBe(200);
      expect(resumeRes.json().ok).toBe(true);
      expect(resumeRes.json().midiConnectionState).toBe('connected');

      // Mobile session remains authenticated seamlessly after desktop resume
      const postResumeVol = await app.inject({
        method: 'PUT',
        url: '/api/volume',
        headers: { ...mobileHeaders, cookie: cookieHeader },
        payload: { volume: 78 },
      });
      expect(postResumeVol.statusCode).toBe(200);
      expect(postResumeVol.json().state.confirmedState.volume).toBe(78);
    } finally {
      await app.close();
    }
  });

  it('4. ControllerStateManager and createBackendApp enforce packaged MOCK block when midiAdapter is omitted', async () => {
    const prevAdapter = process.env.QUICKTONE_MIDI_ADAPTER;
    const prevPackaged = process.env.MG_IS_PACKAGED;
    const prevAllowMock = process.env.MG_ALLOW_PACKAGED_MOCK;

    process.env.QUICKTONE_MIDI_ADAPTER = 'mock';
    process.env.MG_IS_PACKAGED = '1';
    delete process.env.MG_ALLOW_PACKAGED_MOCK;

    const manager = new ControllerStateManager({ autoConnectMidiOnInit: false });
    const app = createBackendApp({ autoConnectMidiOnInit: false });
    try {
      expect(manager.getState().midiAdapterMode).toBe('hardware');
      expect(app.stateManager.getState().midiAdapterMode).toBe('hardware');
    } finally {
      manager.dispose();
      await app.close();
      if (prevAdapter === undefined) delete process.env.QUICKTONE_MIDI_ADAPTER;
      else process.env.QUICKTONE_MIDI_ADAPTER = prevAdapter;
      if (prevPackaged === undefined) delete process.env.MG_IS_PACKAGED;
      else process.env.MG_IS_PACKAGED = prevPackaged;
      if (prevAllowMock === undefined) delete process.env.MG_ALLOW_PACKAGED_MOCK;
      else process.env.MG_ALLOW_PACKAGED_MOCK = prevAllowMock;
    }
  });

  it('5. POST /api/system/resume preserves reconnecting loop when USB is still enumerating and reconnects once available', async () => {
    const mockAdapter = new MockMidiAdapter({ autoConfirmHardware: true });
    const app = createBackendApp({
      midiAdapter: mockAdapter,
      midiOptions: { autoReconnect: true, reconnectIntervalMs: 5_000 },
      autoConnectMidiOnInit: true,
      includeFactoryPresets: true,
      enableSysExSync: false,
      experimentalEdit: false,
    });

    try {
      await app.ready();
      await app.stateManager.initialize();
      expect(app.stateManager.getState().connectionState).toBe('connected');

      // Disconnect USB so MidiService enters 'reconnecting'
      mockAdapter.simulateUnexpectedDisconnect('Sleep suspend USB', true);
      expect(app.stateManager.getState().connectionState).toBe('reconnecting');

      // Resume arrives BEFORE USB hardware finishes enumerating -> must stay 'reconnecting', NOT 'error'
      const earlyResume = await app.inject({ method: 'POST', url: '/api/system/resume' });
      expect(earlyResume.statusCode).toBe(200);
      expect(earlyResume.json().midiConnectionState).toBe('reconnecting');
      expect(app.stateManager.getState().connectionState).toBe('reconnecting');

      // Hardware finishes enumerating -> next resume (or reconnect tick) connects cleanly
      mockAdapter.simulateDeviceReconnected();
      const lateResume = await app.inject({ method: 'POST', url: '/api/system/resume' });
      expect(lateResume.statusCode).toBe(200);
      expect(lateResume.json().midiConnectionState).toBe('connected');
    } finally {
      await app.close();
    }
  });

  it('6. POST /api/pairing/challenge via app.inject preserves configured serverPort instead of forcing 3001', async () => {
    const app = createBackendApp({
      midiAdapter: new MockMidiAdapter(),
      autoConnectMidiOnInit: false,
      serverPort: 4123,
      experimentalEdit: false,
    });

    try {
      await app.ready();
      const challengeRes = await app.inject({ method: 'POST', url: '/api/pairing/challenge' });
      expect(challengeRes.statusCode).toBe(200);
      const body = challengeRes.json() as { challenge: { pairingUrl: string } };
      const parsedUrl = new URL(body.challenge.pairingUrl);
      expect(parsedUrl.port).toBe('4123');
    } finally {
      await app.close();
    }
  });
});
