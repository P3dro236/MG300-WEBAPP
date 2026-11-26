import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type {
  MidiPortInfo,
  PairingChallengeInfo,
  PairingSessionInfo,
  PendingPairingRequest,
  TrustedDeviceInfo,
} from '@quicktone/shared';
import { useFocusTrap } from '../hooks/useFocusTrap';
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
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  useFocusTrap(dialogRef, isOpen, onClose);

  useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!isOpen) return;
    setSelectedPort((prev) => {
      const prevStillAvailable = Boolean(prev) && availablePorts.some((p) => p.name === prev);
      if (!justOpened && prevStillAvailable) {
        return prev;
      }
      return connectedPortName ?? availablePorts[0]?.name ?? '';
    });
  }, [connectedPortName, availablePorts, isOpen]);

  useEffect(() => {
    if (!isOpen || !activeChallenge) {
      return;
    }
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isOpen, activeChallenge]);

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
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-bg-scrim p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-[var(--radius-lg)] border border-border-strong bg-bg-surface p-4 shadow-[var(--shadow-modal)] sm:p-6"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-4">
          <div>
            <h2
              id="settings-modal-title"
              className="font-sans text-base font-semibold text-text-primary sm:text-lg"
            >
              Configurações de Conexão e Acesso
            </h2>
            <p className="font-mono text-[11px] text-text-muted">
              NUX MG-300 · Porta MIDI &amp; Rede Local
            </p>
          </div>

          <button
            type="button"
            data-testid="close-settings-btn"
            aria-label="Fechar configurações"
            onClick={onClose}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-md)] border border-border-subtle bg-bg-elevated px-3 font-sans text-xs font-medium text-text-primary transition-colors duration-150 hover:border-border-hover lg:min-h-[38px] cursor-pointer"
          >
            <X className="h-4 w-4 sm:hidden" strokeWidth={1.75} aria-hidden="true" />
            <span className="hidden sm:inline">Fechar</span>
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-6">
          {/* Porta MIDI */}
          <div className="flex flex-col gap-2">
            <label
              htmlFor="midi-port-select"
              className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted"
            >
              Porta MIDI
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                id="midi-port-select"
                name="midi-port"
                data-testid="midi-port-select"
                value={selectedPort}
                onChange={(e) => setSelectedPort(e.target.value)}
                className="min-h-[44px] flex-1 rounded-[var(--radius-md)] border border-border-strong bg-bg-recess px-3 font-mono text-xs text-text-primary"
              >
                {availablePorts.length === 0 ? (
                  <option value="" className="bg-bg-surface text-text-primary">
                    Nenhuma porta MIDI detectada
                  </option>
                ) : (
                  availablePorts.map((port) => (
                    <option
                      key={port.id}
                      value={port.name}
                      className="bg-bg-surface text-text-primary"
                    >
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
                className="min-h-[44px] rounded-[var(--radius-md)] border border-border-strong bg-bg-elevated px-4 font-sans text-xs font-semibold text-text-primary transition-colors duration-150 hover:border-border-hover disabled:opacity-40 cursor-pointer"
              >
                Conectar porta
              </button>
            </div>
          </div>

          {/* Acesso Mobile via QR Code (Desktop) vs Sessão Ativa (Mobile) */}
          {isLocalDesktop ? (
            <div
              data-testid="lan-qr-card"
              className="flex flex-col gap-4 border-t border-border-subtle pt-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="font-mono text-xs font-semibold uppercase tracking-wider text-text-primary">
                    Pareamento de Celular via QR Code
                  </span>
                  <p className="mt-1 font-sans text-xs text-text-muted">
                    Apenas um celular autorizado por vez pode controlar a pedaleira na rede Wi-Fi.
                  </p>
                </div>

                <button
                  type="button"
                  data-testid="generate-pairing-qr-btn"
                  disabled={generatingQr}
                  onClick={() => void handleGenerateQr()}
                  className="min-h-[44px] shrink-0 rounded-[var(--radius-md)] border border-accent-border bg-bg-elevated px-3.5 font-sans text-xs font-semibold text-accent transition-colors duration-150 hover:border-accent disabled:opacity-50 cursor-pointer"
                >
                  {generatingQr
                    ? 'Gerando…'
                    : activeChallenge && !challengeExpired
                      ? 'Gerar novo QR Code'
                      : 'Gerar QR Code'}
                </button>
              </div>

              {activeChallenge && !challengeExpired ? (
                <div
                  data-testid="pairing-challenge-box"
                  className="flex flex-col items-center gap-4 rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-2">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-accent tabular-nums">
                      QR Code temporário ({remainingSeconds}s)
                    </span>
                    <p className="font-sans text-xs leading-relaxed text-text-muted">
                      Aponte a câmera do celular conectado ao mesmo Wi-Fi. Após ler o QR Code,
                      autorize a conexão aqui no computador.
                    </p>
                    {lanUrls.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {lanUrls.map((url) => (
                          <code
                            key={url}
                            data-testid="lan-url-item"
                            className="rounded-[var(--radius-sm)] border border-border-subtle bg-bg-surface px-2.5 py-1 font-mono text-[11px] text-text-muted break-all"
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
                <p className="font-sans text-xs text-text-muted">
                  Clique em <strong className="text-text-primary">Gerar QR Code</strong> para
                  liberar um pareamento temporário de uso único.
                </p>
              )}

              {pendingRequests.length > 0 ? (
                <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-status-warning">
                    Aguardando Autorização
                  </span>
                  {pendingRequests.map((req) => (
                    <div
                      key={req.requestId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-status-warning-border bg-status-warning-bg p-3"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="rounded-[var(--radius-sm)] border border-border-subtle bg-bg-recess px-2 py-0.5 font-mono text-xs font-bold text-text-primary tabular-nums">
                          {req.verificationCode}
                        </span>
                        <span className="font-sans text-xs text-text-primary">
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
                          className="min-h-[44px] rounded-[var(--radius-md)] border border-border-strong bg-bg-recess px-3 font-sans text-xs text-text-muted transition-colors hover:text-text-primary disabled:opacity-40 lg:min-h-[36px] cursor-pointer"
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
                          className="min-h-[44px] rounded-[var(--radius-md)] border border-status-confirmed-border bg-status-confirmed-bg px-3 font-sans text-xs font-semibold text-status-confirmed disabled:opacity-40 lg:min-h-[36px] cursor-pointer"
                        >
                          Autorizar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-4">
                {activeSession ? (
                  <>
                    <div
                      data-testid="active-mobile-session"
                      className="flex flex-col gap-0.5"
                    >
                      <span className="font-mono text-[11px] font-semibold text-status-confirmed">
                        CELULAR CONTROLADOR ATIVO
                      </span>
                      <span className="font-sans text-xs text-text-primary">
                        {activeSession.deviceName} ({activeSession.remoteIp})
                      </span>
                    </div>
                    <button
                      type="button"
                      data-testid="revoke-mobile-btn"
                      disabled={busyAction !== null}
                      onClick={() => void runAction('revoke', onRevokeMobileSession)}
                      className="min-h-[44px] rounded-[var(--radius-md)] border border-status-error-border bg-status-error-bg px-3 font-sans text-xs font-semibold text-status-error transition-colors hover:border-status-error disabled:opacity-40 lg:min-h-[38px] cursor-pointer"
                    >
                      Revogar acesso
                    </button>
                  </>
                ) : (
                  <span className="font-sans text-xs text-text-muted">
                    Nenhum celular conectado no momento.
                  </span>
                )}
              </div>

              <div
                data-testid="trusted-devices-section"
                className="flex flex-col gap-2 border-t border-border-subtle pt-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">
                    Dispositivos Confiáveis ({trustedDevices.length})
                  </span>
                  <span className="font-mono text-[11px] text-text-muted">
                    Reconectam sem novo QR Code
                  </span>
                </div>
                {trustedDevices.length === 0 ? (
                  <span className="font-sans text-xs text-text-muted">
                    Nenhum dispositivo salvo ainda. Aprove um celular via QR Code para salvá-lo.
                  </span>
                ) : (
                  <div className="flex flex-col divide-y divide-border-subtle rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess">
                    {trustedDevices.map((dev) => (
                      <div
                        key={dev.deviceId}
                        data-testid={`trusted-device-row-${dev.deviceId}`}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-sans text-xs font-medium text-text-primary">
                              {dev.deviceName}
                            </span>
                            {dev.isCurrentlyActive ? (
                              <span className="rounded-[var(--radius-sm)] border border-status-confirmed-border bg-status-confirmed-bg px-1.5 py-0.5 font-mono text-[11px] font-semibold text-status-confirmed">
                                ATIVO
                              </span>
                            ) : null}
                          </div>
                          <span className="font-mono text-[11px] text-text-muted tabular-nums">
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
                            className="min-h-[44px] rounded-[var(--radius-md)] border border-status-error-border bg-status-error-bg px-3 font-sans text-xs font-semibold text-status-error transition-colors duration-150 hover:border-status-error disabled:opacity-40 lg:min-h-[36px] cursor-pointer"
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
            <div className="flex flex-col gap-3 border-t border-border-subtle pt-5">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-text-primary">
                Sessão Mobile Autorizada
              </span>
              {activeSession ? (
                <p className="font-sans text-xs text-text-muted">
                  Dispositivo: <strong className="text-text-primary">{activeSession.deviceName}</strong>{' '}
                  ({activeSession.remoteIp})
                </p>
              ) : null}
              <button
                type="button"
                data-testid="logout-mobile-btn"
                disabled={busyAction !== null}
                onClick={() => void runAction('logout', onLogoutMobileSession)}
                className="min-h-[44px] self-start rounded-[var(--radius-md)] border border-status-error-border bg-status-error-bg px-4 font-sans text-xs font-semibold text-status-error transition-colors hover:border-status-error disabled:opacity-40 cursor-pointer"
              >
                Encerrar sessão neste celular
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
