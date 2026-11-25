import React, { useEffect, useState } from 'react';
import type { MidiPortInfo, VolumeTarget } from '@quicktone/shared';
import { QrCodeSvg } from './QrCodeSvg';

interface SettingsModalProps {
  isOpen: boolean;
  presetsDirectory: string | null;
  volumeTarget: VolumeTarget;
  availablePorts: MidiPortInfo[];
  connectedPortName: string | null;
  deviceFirmwareVersion?: string | null;
  lanUrls?: string[];
  authRequired: boolean;
  currentToken: string;
  includeFactoryPresets?: boolean;
  onClose: () => void;
  onSavePresetsDirectory: (directoryPath: string) => Promise<void>;
  onToggleFactoryPresets?: (include: boolean) => Promise<void> | void;
  onSelectVolumeTarget: (target: VolumeTarget) => void;
  onConnectMidiPort: (portName: string) => void;
  onSaveToken: (token: string) => void;
}

const VOLUME_TARGET_OPTIONS: ReadonlyArray<{
  id: VolumeTarget;
  label: string;
  description: string;
}> = [
  {
    id: 'master_cc64',
    label: 'Volume Master (CC 64)',
    description: 'Knob físico MASTER global da MG-300 (0..100).',
  },
  {
    id: 'patch_cc74',
    label: 'Patch Level P.LVL (CC 74)',
    description: 'Nível de saída específico do preset ativo (0..100).',
  },
  {
    id: 'expression_cc61',
    label: 'Pedal de Expressão (CC 61)',
    description: 'Emula o pedal de expressão físico em tempo real (0..100).',
  },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  presetsDirectory,
  volumeTarget,
  availablePorts,
  connectedPortName,
  deviceFirmwareVersion,
  lanUrls = [],
  authRequired,
  currentToken,
  includeFactoryPresets = true,
  onClose,
  onSavePresetsDirectory,
  onToggleFactoryPresets,
  onSelectVolumeTarget,
  onConnectMidiPort,
  onSaveToken,
}) => {
  const [dirInput, setDirInput] = useState(presetsDirectory ?? '');
  const [selectedPort, setSelectedPort] = useState(
    connectedPortName ?? availablePorts[0]?.name ?? '',
  );
  const [tokenInput, setTokenInput] = useState(currentToken);
  const [savingDir, setSavingDir] = useState(false);

  useEffect(() => {
    setDirInput(presetsDirectory ?? '');
  }, [presetsDirectory, isOpen]);

  useEffect(() => {
    setSelectedPort(connectedPortName ?? availablePorts[0]?.name ?? '');
  }, [connectedPortName, availablePorts, isOpen]);

  useEffect(() => {
    setTokenInput(currentToken);
  }, [currentToken, isOpen]);

  if (!isOpen) {
    return null;
  }

  const primaryLanUrl = lanUrls[0] ?? '';

  const handleSaveDirectory = async (): Promise<void> => {
    const trimmed = dirInput.trim();
    if (!trimmed) return;
    setSavingDir(true);
    try {
      await onSavePresetsDirectory(trimmed);
    } finally {
      setSavingDir(false);
    }
  };

  return (
    <div
      data-testid="settings-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Configurações do controlador"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-5"
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-md border border-white/15 bg-[#14161A] p-4 sm:p-5">
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
          <div>
            <h2 className="font-sans text-base font-semibold text-[#F3F4F6]">
              Configurações de Hardware e Rede
            </h2>
            <p className="font-mono text-[11px] text-[#8E95A2]">
              {deviceFirmwareVersion
                ? `Firmware detectado: ${deviceFirmwareVersion}`
                : 'NUX MG-300 · WinMM + SysEx Read-Only'}
            </p>
          </div>

          <button
            type="button"
            data-testid="close-settings-btn"
            onClick={onClose}
            className="min-h-[36px] rounded border border-white/10 bg-[#1B1E24] px-3 font-mono text-xs text-[#F3F4F6] hover:border-white/25"
          >
            Fechar
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-5">
          {/* Porta MIDI */}
          <div className="flex flex-col gap-2">
            <label
              htmlFor="midi-port-select"
              className="font-mono text-xs font-semibold uppercase tracking-wider text-[#8E95A2]"
            >
              Porta MIDI WinMM
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                id="midi-port-select"
                data-testid="midi-port-select"
                value={selectedPort}
                onChange={(e) => setSelectedPort(e.target.value)}
                className="min-h-[40px] flex-1 rounded border border-white/10 bg-[#090A0C] px-2.5 font-mono text-xs text-[#F3F4F6] focus:border-white/25 focus:outline-none"
              >
                {availablePorts.length === 0 ? (
                  <option value="">Nenhuma porta MIDI detectada</option>
                ) : (
                  availablePorts.map((port) => (
                    <option key={port.id} value={port.name}>
                      {port.name} ({port.direction.toUpperCase()}
                      {port.isMg300 ? ' · MG-300' : ''})
                    </option>
                  ))
                )}
              </select>

              <button
                type="button"
                data-testid="connect-selected-port-btn"
                disabled={!selectedPort}
                onClick={() => {
                  if (selectedPort) onConnectMidiPort(selectedPort);
                }}
                className="min-h-[40px] rounded border border-white/15 bg-[#1B1E24] px-4 font-mono text-xs font-semibold text-[#F3F4F6] hover:border-white/30 disabled:opacity-40"
              >
                Conectar Porta
              </button>
            </div>
          </div>

          {/* Alvo CC de Volume */}
          <div className="flex flex-col gap-2">
            <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#8E95A2]">
              Alvo CC do Fader de Volume
            </span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {VOLUME_TARGET_OPTIONS.map((option) => {
                const selected = option.id === volumeTarget;
                return (
                  <button
                    key={option.id}
                    type="button"
                    data-testid={`volume-target-option-${option.id}`}
                    onClick={() => onSelectVolumeTarget(option.id)}
                    className={`rounded border p-2.5 text-left transition-colors duration-150 ${
                      selected
                        ? 'border-[#22C55E]/60 bg-[#141A16] text-[#F3F4F6]'
                        : 'border-white/[0.08] bg-[#090A0C] text-[#8E95A2] hover:border-white/20'
                    }`}
                  >
                    <div className="font-mono text-xs font-semibold text-[#F3F4F6]">
                      {option.label}
                    </div>
                    <div className="mt-1 font-sans text-[11px] leading-snug text-[#8E95A2]">
                      {option.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Pasta QuickTone */}
          <div className="flex flex-col gap-2">
            <label
              htmlFor="presets-dir-input"
              className="font-mono text-xs font-semibold uppercase tracking-wider text-[#8E95A2]"
            >
              Pasta de Presets QuickTone (.nuxpreset)
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="presets-dir-input"
                data-testid="presets-dir-input"
                type="text"
                value={dirInput}
                onChange={(e) => setDirInput(e.target.value)}
                placeholder="Ex.: C:\Users\pedro\Documents\NUX"
                className="min-h-[40px] flex-1 rounded border border-white/10 bg-[#090A0C] px-3 font-mono text-xs text-[#F3F4F6] placeholder:text-[#525866] focus:border-white/25 focus:outline-none"
              />

              <button
                type="button"
                data-testid="save-presets-dir-btn"
                disabled={savingDir || !dirInput.trim()}
                onClick={() => void handleSaveDirectory()}
                className="min-h-[40px] rounded border border-white/15 bg-[#1B1E24] px-4 font-mono text-xs font-semibold text-[#F3F4F6] hover:border-white/30 disabled:opacity-40"
              >
                {savingDir ? 'Salvando...' : 'Salvar Pasta'}
              </button>
            </div>
            {onToggleFactoryPresets ? (
              <label className="mt-1 flex cursor-pointer items-center gap-2 font-sans text-xs text-[#F3F4F6]">
                <input
                  type="checkbox"
                  data-testid="include-factory-presets-toggle"
                  checked={includeFactoryPresets}
                  onChange={(e) => void onToggleFactoryPresets(e.target.checked)}
                  className="h-4 w-4 rounded border border-white/20 bg-[#090A0C] accent-[#F59E0B]"
                />
                <span>Incluir os 36 presets de fábrica (F1A–F9D)</span>
              </label>
            ) : null}
          </div>

          {/* Token LAN */}
          <div className="flex flex-col gap-2">
            <label
              htmlFor="lan-token-input"
              className="font-mono text-xs font-semibold uppercase tracking-wider text-[#8E95A2]"
            >
              Token / PIN LAN {authRequired ? '(Obrigatório no servidor)' : '(Opcional)'}
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="lan-token-input"
                data-testid="lan-token-input"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Token configurado em QUICKTONE_AUTH_TOKEN"
                className="min-h-[40px] flex-1 rounded border border-white/10 bg-[#090A0C] px-3 font-mono text-xs text-[#F3F4F6] placeholder:text-[#525866] focus:border-white/25 focus:outline-none"
              />
              <button
                type="button"
                data-testid="save-lan-token-btn"
                onClick={() => onSaveToken(tokenInput)}
                className="min-h-[40px] rounded border border-white/15 bg-[#1B1E24] px-4 font-mono text-xs font-semibold text-[#F3F4F6] hover:border-white/30"
              >
                Aplicar Token
              </button>
            </div>
          </div>

          {/* Acesso Mobile Wi-Fi + QR Code */}
          {lanUrls.length > 0 ? (
            <div
              data-testid="lan-qr-card"
              className="flex flex-col gap-3 rounded border border-white/[0.08] bg-[#090A0C] p-3.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#F3F4F6]">
                  Acesso Mobile via Wi-Fi LAN
                </span>
                <p className="font-sans text-xs text-[#8E95A2]">
                  Escaneie com a câmera do celular conectado à mesma rede Wi-Fi:
                </p>
                <div className="mt-1 flex flex-col gap-1">
                  {lanUrls.map((url) => (
                    <code
                      key={url}
                      data-testid="lan-url-item"
                      className="rounded border border-white/[0.06] bg-[#14161A] px-2 py-1 font-mono text-xs text-[#F3F4F6] select-all"
                    >
                      {url}
                    </code>
                  ))}
                </div>
              </div>

              {primaryLanUrl ? (
                <div className="shrink-0 self-start sm:self-center">
                  <QrCodeSvg value={primaryLanUrl} sizePx={116} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
