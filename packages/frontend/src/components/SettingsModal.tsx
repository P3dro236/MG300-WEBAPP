import React, { useEffect, useState } from 'react';
import type {
  MidiPortInfo,
  PairingChallengeInfo,
  PairingSessionInfo,
  PendingPairingRequest,
  TrustedDeviceInfo,
} from '@quicktone/shared';
import { QrCodeSvg } from './QrCodeSvg';

interface SettingsModalProps {
  isOpen: boolean;
  availablePorts: MidiPortInfo[];
  connectedPortName: string | null;
  isLocalDesktop: boolean;
  lanUrls?: string[];
  activeSession: PairingSessionInfo | null;
  pendingRequests: PendingPairingRequest[];
  activeChallenge: PairingChallengeInfo | null;
  trustedDevices?: TrustedDeviceInfo[];
  onClose: () => void;
  onConnectMidiPort: (portName: string) => void;
  onGeneratePairingQr: () => Promise<void>;
  onApprovePairing: (requestId: string) => Promise<void>;
  onRejectPairing: (requestId: string) => Promise<void>;
  onRevokeMobileSession: () => Promise<void>;
  onLogoutMobileSession: () => Promise<void>;
  onRemoveTrustedDevice?: (deviceId: string) => Promise<void>;
}

function formatSecondsRemaining(expiresAt: string | undefined, nowMs: number): number {
  if (!expiresAt) return 0;
  const diff = Math.ceil((Date.parse(expiresAt) - nowMs) / 1000);
  return Number.isFinite(diff) && diff > 0 ? diff : 0;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  availablePorts,
  connectedPortName,
  isLocalDesktop,
  lanUrls = [],
  activeSession,
  pendingRequests,
  activeChallenge,
  trustedDevices = [],
  onClose,
  onConnectMidiPort,
  onGeneratePairingQr,
  onApprovePairing,
  onRejectPairing,
  onRevokeMobileSession,
  onLogoutMobileSession,
  onRemoveTrustedDevice,
}) => {
  const [selectedPort, setSelectedPort] = useState(
    connectedPortName ?? availablePorts[0]?.name ?? '',
  );
  const [generatingQr, setGeneratingQr] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setSelectedPort(connectedPortName ?? availablePorts[0]?.name ?? '');
  }, [connectedPortName, availablePorts, isOpen]);

  useEffect(() => {
    if (!isOpen || !activeChallenge) {
      return;
    }
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isOpen, activeChallenge]);

  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const runAction = async (key: string, fn: () => Promise<void> | void): Promise<void> => {
    if (busyAction !== null) return;
    setBusyAction(key);
    try {
      await fn();
    } finally {
      setBusyAction(null);
    }
  };

  if (!isOpen) {
    return null;
  }

  const remainingSeconds = formatSecondsRemaining(activeChallenge?.expiresAt, nowMs);
  const challengeExpired = Boolean(activeChallenge) && remainingSeconds <= 0;

  const handleGenerateQr = async (): Promise<void> => {
    setGeneratingQr(true);
    try {
      await onGeneratePairingQr();
    } finally {
      setGeneratingQr(false);
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
              Configurações de Conexão e Acesso
            </h2>
            <p className="font-mono text-[11px] text-[#8E95A2]">
              NUX MG-300 · Controle Master &amp; Rede Local
            </p>
          </div>

          <button
            type="button"
            data-testid="close-settings-btn"
            onClick={onClose}
            className="min-h-[44px] rounded border border-white/10 bg-[#1B1E24] px-3 font-mono text-xs text-[#F3F4F6] hover:border-white/25 sm:min-h-[36px]"
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
              Porta MIDI
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

          {/* Acesso Mobile via QR Code (Desktop) vs Sessão Ativa (Mobile) */}
          {isLocalDesktop ? (
            <div
              data-testid="lan-qr-card"
              className="flex flex-col gap-3 rounded border border-white/[0.08] bg-[#090A0C] p-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#F3F4F6]">
                    Pareamento de Celular via QR Code
                  </span>
                  <p className="mt-0.5 font-sans text-xs text-[#8E95A2]">
                    Apenas um celular autorizado por vez pode controlar a pedaleira na rede
                    Wi-Fi.
                  </p>
                </div>

                <button
                  type="button"
                  data-testid="generate-pairing-qr-btn"
                  disabled={generatingQr}
                  onClick={() => void handleGenerateQr()}
                  className="min-h-[40px] shrink-0 rounded border border-[#F59E0B]/50 bg-[#1B1E24] px-3.5 font-mono text-xs font-semibold text-[#F59E0B] hover:border-[#F59E0B] disabled:opacity-50"
                >
                  {generatingQr
                    ? 'Gerando...'
                    : activeChallenge && !challengeExpired
                      ? 'Gerar Novo QR Code'
                      : 'Gerar QR Code'}
                </button>
              </div>

              {activeChallenge && !challengeExpired ? (
                <div
                  data-testid="pairing-challenge-box"
                  className="flex flex-col items-center gap-4 rounded border border-white/[0.06] bg-[#14161A] p-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-1.5">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#F59E0B]">
                      QR Code temporário ({remainingSeconds}s)
                    </span>
                    <p className="font-sans text-xs leading-relaxed text-[#8E95A2]">
                      Aponte a câmera do celular conectado ao mesmo Wi-Fi. Após o scan,
                      confirme a autorização aqui no computador.
                    </p>
                    {lanUrls.length > 0 ? (
                      <div className="mt-1 flex flex-col gap-1">
                        {lanUrls.map((url) => (
                          <code
                            key={url}
                            data-testid="lan-url-item"
                            className="rounded border border-white/[0.06] bg-[#090A0C] px-2 py-1 font-mono text-[11px] text-[#8E95A2]"
                          >
                            {url}
                          </code>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="shrink-0">
                    <QrCodeSvg value={activeChallenge.pairingUrl} sizePx={136} />
                  </div>
                </div>
              ) : (
                <div className="rounded border border-white/[0.06] bg-[#14161A] p-3 font-sans text-xs text-[#8E95A2]">
                  Clique em <strong className="text-[#F3F4F6]">Gerar QR Code</strong>{' '}
                  para liberar um pareamento temporário de uso único.
                </div>
              )}

              {pendingRequests.length > 0 ? (
                <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#F59E0B]">
                    Aguardando Autorização
                  </span>
                  {pendingRequests.map((req) => (
                    <div
                      key={req.requestId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#F59E0B]/40 bg-[#1B1710] p-2.5"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="rounded border border-white/10 bg-[#090A0C] px-2 py-0.5 font-mono text-xs font-bold text-[#F3F4F6] tabular-nums">
                          {req.verificationCode}
                        </span>
                        <span className="font-sans text-xs text-[#F3F4F6]">
                          {req.deviceName} ({req.remoteIp})
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            void runAction(`reject:${req.requestId}`, () =>
                              onRejectPairing(req.requestId),
                            )
                          }
                          className="min-h-[44px] rounded border border-white/15 bg-[#090A0C] px-3 font-mono text-xs text-[#8E95A2] hover:text-[#F3F4F6] disabled:opacity-40 sm:min-h-[36px]"
                        >
                          Recusar
                        </button>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            void runAction(`approve:${req.requestId}`, () =>
                              onApprovePairing(req.requestId),
                            )
                          }
                          className="min-h-[44px] rounded border border-[#22C55E]/60 bg-[#141A16] px-3 font-mono text-xs font-semibold text-[#22C55E] disabled:opacity-40 sm:min-h-[36px]"
                        >
                          Autorizar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                {activeSession ? (
                  <>
                    <div
                      data-testid="active-mobile-session"
                      className="flex flex-col gap-0.5"
                    >
                      <span className="font-mono text-[11px] font-semibold text-[#22C55E]">
                        CELULAR CONTROLADOR ATIVO
                      </span>
                      <span className="font-sans text-xs text-[#F3F4F6]">
                        {activeSession.deviceName} ({activeSession.remoteIp})
                      </span>
                    </div>
                    <button
                      type="button"
                      data-testid="revoke-mobile-btn"
                      disabled={busyAction !== null}
                      onClick={() => void runAction('revoke', onRevokeMobileSession)}
                      className="min-h-[44px] rounded border border-[#EF4444]/50 bg-[#EF4444]/10 px-3 font-mono text-xs font-semibold text-[#EF4444] hover:border-[#EF4444] disabled:opacity-40 sm:min-h-[38px]"
                    >
                      Revogar Acesso
                    </button>
                  </>
                ) : (
                  <span className="font-sans text-xs text-[#8E95A2]">
                    Nenhum celular conectado no momento.
                  </span>
                )}
              </div>

              <div
                data-testid="trusted-devices-section"
                className="flex flex-col gap-2 border-t border-white/[0.06] pt-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#F3F4F6]">
                    Dispositivos Confiáveis ({trustedDevices.length})
                  </span>
                  <span className="font-mono text-[10px] text-[#8E95A2]">
                    Reconectam sem novo QR Code
                  </span>
                </div>
                {trustedDevices.length === 0 ? (
                  <span className="font-sans text-xs text-[#8E95A2]">
                    Nenhum dispositivo salvo ainda. Aprove um celular via QR Code para salvá-lo.
                  </span>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {trustedDevices.map((dev) => (
                      <div
                        key={dev.deviceId}
                        data-testid={`trusted-device-row-${dev.deviceId}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-white/[0.06] bg-[#14161A] px-3 py-2"
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-sans text-xs font-medium text-[#F3F4F6]">
                              {dev.deviceName}
                            </span>
                            {dev.isCurrentlyActive ? (
                              <span className="rounded border border-[#22C55E]/40 bg-[#22C55E]/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#22C55E]">
                                ATIVO
                              </span>
                            ) : null}
                          </div>
                          <span className="font-mono text-[11px] text-[#8E95A2] tabular-nums">
                            {dev.remoteIp}
                          </span>
                        </div>
                        {onRemoveTrustedDevice ? (
                          <button
                            type="button"
                            data-testid={`remove-trusted-device-btn-${dev.deviceId}`}
                            disabled={busyAction !== null}
                            onClick={() =>
                              void runAction(`remove:${dev.deviceId}`, () =>
                                onRemoveTrustedDevice(dev.deviceId),
                              )
                            }
                            className="min-h-[44px] rounded border border-[#EF4444]/40 bg-[#EF4444]/10 px-2.5 font-mono text-[11px] font-semibold text-[#EF4444] transition-colors duration-150 hover:border-[#EF4444] disabled:opacity-40 sm:min-h-[36px]"
                          >
                            Remover
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded border border-white/[0.08] bg-[#090A0C] p-3.5">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#F3F4F6]">
                Sessão Mobile Autorizada
              </span>
              {activeSession ? (
                <p className="font-sans text-xs text-[#8E95A2]">
                  Dispositivo: <strong className="text-[#F3F4F6]">{activeSession.deviceName}</strong>{' '}
                  ({activeSession.remoteIp})
                </p>
              ) : null}
              <button
                type="button"
                data-testid="logout-mobile-btn"
                disabled={busyAction !== null}
                onClick={() => void runAction('logout', onLogoutMobileSession)}
                className="min-h-[44px] self-start rounded border border-[#EF4444]/50 bg-[#EF4444]/10 px-4 font-mono text-xs font-semibold text-[#EF4444] disabled:opacity-40 sm:min-h-[40px]"
              >
                Encerrar Sessão neste Celular
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
