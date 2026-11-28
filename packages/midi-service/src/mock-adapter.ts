import { MG300_MIDI_CC, type MidiPortInfo } from '@quicktone/shared';
import { type IMidiAdapter, isMg300PortName, MidiServiceError } from './types.js';

export interface MockMidiAdapterOptions {
  initialPorts?: MidiPortInfo[];
  autoConfirmHardware?: boolean;
}

const DEFAULT_MOCK_PORTS: MidiPortInfo[] = [
  {
    id: 'nux-nme-300',
    name: 'NUX NME-300',
    direction: 'duplex',
    isMg300: true,
  },
];

export class MockMidiAdapter implements IMidiAdapter {
  public readonly isMock = true;
  private ports: MidiPortInfo[];
  private savedPortsBeforeDisconnect: MidiPortInfo[] | null = null;
  private connectedPortName: string | null = null;
  private readonly busyPorts = new Set<string>();
  private readonly sentMessages: number[][] = [];
  private readonly incomingListeners = new Set<(bytes: number[]) => void>();
  private readonly disconnectListeners = new Set<(reason?: string) => void>();
  private autoConfirmHardware: boolean;
  private failOnSend = false;

  constructor(options: MockMidiAdapterOptions = {}) {
    this.ports = options.initialPorts
      ? options.initialPorts.map((p) => ({ ...p }))
      : DEFAULT_MOCK_PORTS.map((p) => ({ ...p }));
    this.autoConfirmHardware = options.autoConfirmHardware ?? false;
  }

  public async listPorts(): Promise<MidiPortInfo[]> {
    return this.ports.map((port) => ({
      ...port,
      isMg300: port.isMg300 || isMg300PortName(port.name),
    }));
  }

  public async openPort(portName: string): Promise<{ portName: string }> {
    const normalizedRequested = portName.trim().toLowerCase();
    const matchedPort = this.ports.find(
      (p) =>
        p.name.toLowerCase() === normalizedRequested ||
        p.id.toLowerCase() === normalizedRequested,
    );

    if (!matchedPort) {
      throw new MidiServiceError(
        'DEVICE_NOT_FOUND',
        `Dispositivo MIDI "${portName}" não encontrado nas portas disponíveis.`,
      );
    }

    if (this.busyPorts.has(matchedPort.name) || this.busyPorts.has(matchedPort.id)) {
      throw new MidiServiceError(
        'PORT_BUSY',
        `A porta MIDI "${matchedPort.name}" está ocupada por outro aplicativo (ex.: QuickTone Desktop).`,
      );
    }

    this.connectedPortName = matchedPort.name;
    return { portName: matchedPort.name };
  }

  public async closePort(): Promise<void> {
    this.connectedPortName = null;
  }

  public isConnected(): boolean {
    return this.connectedPortName !== null;
  }

  public getConnectedPortName(): string | null {
    return this.connectedPortName;
  }

  public async sendBytes(bytes: number[]): Promise<void> {
    if (!this.connectedPortName) {
      throw new MidiServiceError(
        'DISCONNECTED',
        'Não é possível enviar mensagem MIDI: nenhum dispositivo conectado.',
      );
    }

    if (this.failOnSend) {
      throw new MidiServiceError(
        'TRANSMISSION_FAILED',
        `Falha simulada ao transmitir bytes MIDI para "${this.connectedPortName}".`,
      );
    }

    const copy = [...bytes];
    this.sentMessages.push(copy);

    if (this.autoConfirmHardware && copy.length === 3) {
      const status = copy[0]! & 0xf0;
      const cc = copy[1]!;
      if (
        status === 0xb0 &&
        (cc === MG300_MIDI_CC.PRESET_SELECT ||
          cc === MG300_MIDI_CC.MASTER_VOLUME ||
          cc === MG300_MIDI_CC.PATCH_LEVEL ||
          cc === MG300_MIDI_CC.EXPRESSION_PEDAL)
      ) {
        this.simulateHardwareIncoming(copy);
      }
    }
  }

  public onIncomingMessage(listener: (bytes: number[]) => void): () => void {
    this.incomingListeners.add(listener);
    return () => {
      this.incomingListeners.delete(listener);
    };
  }

  public onDisconnect(listener: (reason?: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  // Test & simulation helpers

  public setPorts(ports: MidiPortInfo[]): void {
    this.ports = ports.map((p) => ({ ...p }));
    this.savedPortsBeforeDisconnect = null;
  }

  public setPortBusy(portName: string, busy: boolean): void {
    if (busy) {
      this.busyPorts.add(portName);
    } else {
      this.busyPorts.delete(portName);
    }
  }

  public setFailOnSend(fail: boolean): void {
    this.failOnSend = fail;
  }

  public setAutoConfirmHardware(enabled: boolean): void {
    this.autoConfirmHardware = enabled;
  }

  public getSentMessages(): number[][] {
    return this.sentMessages.map((msg) => [...msg]);
  }

  public clearSentMessages(): void {
    this.sentMessages.length = 0;
  }

  public simulateHardwareIncoming(bytes: number[]): void {
    const payload = [...bytes];
    for (const listener of this.incomingListeners) {
      listener(payload);
    }
  }

  public simulateUnexpectedDisconnect(
    reason = 'USB device unplugged',
    removePort = false,
  ): void {
    this.connectedPortName = null;
    if (removePort) {
      this.savedPortsBeforeDisconnect = this.ports.map((p) => ({ ...p }));
      this.ports = [];
    }
    for (const listener of this.disconnectListeners) {
      listener(reason);
    }
  }

  public simulateDeviceReconnected(portsToRestore?: MidiPortInfo[]): void {
    if (portsToRestore) {
      this.ports = portsToRestore.map((p) => ({ ...p }));
      this.savedPortsBeforeDisconnect = null;
      return;
    }
    if (this.savedPortsBeforeDisconnect) {
      this.ports = this.savedPortsBeforeDisconnect.map((p) => ({ ...p }));
      this.savedPortsBeforeDisconnect = null;
      return;
    }
    if (this.ports.length === 0) {
      this.ports = DEFAULT_MOCK_PORTS.map((p) => ({ ...p }));
    }
  }
}
