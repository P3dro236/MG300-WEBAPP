import React, { useEffect, useRef, useState } from 'react';
import { QrCode } from 'lucide-react';
import type { PairingSessionStatus } from '@quicktone/shared';

interface MobilePairingGateProps {
  initialPairingCode: string | null;
  sessionStatus: Exclude<PairingSessionStatus, 'desktop'>;
  isTrustedDevice?: boolean;
  trustedDeviceName?: string | null;
  onTrustedReconnect?: () => Promise<void>;
  onRequestPairing: (params: {
    pairingCode: string;
    deviceName?: string;
  }) => Promise<{
    requestId: string;
    claimSecret: string;
    verificationCode: string;
    expiresAt: string;
  }>;
  onPollPairing: (params: {
    requestId: string;
    claimSecret: string;
  }) => Promise<{ status: string }>;
  onPaired: () => void;
}

type GatePhase =
  | 'unpaired'
  | 'submitting'
  | 'waiting_approval'
  | 'rejected'
  | 'expired'
  | 'rate_limited'
  | 'error';

const DEVICE_NAME_STORAGE_KEY = 'quicktone_mobile_device_name_v1';

function resolveDefaultDeviceName(): string {
  if (typeof navigator === 'undefined') {
    return 'Celular';
  }
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Celular Android';
  return 'Navegador LAN';
}

function loadSavedDeviceName(): string {
  try {
    const saved = globalThis.localStorage?.getItem(DEVICE_NAME_STORAGE_KEY)?.trim();
    if (saved) {
      return saved.slice(0, 60);
    }
  } catch {
    // Ignore restricted/private storage environments
  }
  return resolveDefaultDeviceName();
}

function saveDeviceName(name: string): void {
  try {
    const trimmed = name.trim().slice(0, 60);
    if (trimmed) {
      globalThis.localStorage?.setItem(DEVICE_NAME_STORAGE_KEY, trimmed);
    } else {
      globalThis.localStorage?.removeItem(DEVICE_NAME_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota / private mode failures
  }
}

export const MobilePairingGate: React.FC<MobilePairingGateProps> = ({
  initialPairingCode,
  sessionStatus,
  isTrustedDevice = false,
  trustedDeviceName = null,
  onTrustedReconnect,
  onRequestPairing,
  onPollPairing,
  onPaired,
}) => {
  const [phase, setPhase] = useState<GatePhase>(
    initialPairingCode ? 'submitting' : 'unpaired',
  );
  const [deviceName, setDeviceName] = useState<string>(loadSavedDeviceName);
  const [verificationCode, setVerificationCode] = useState<string | null>(null);
  const [reconnectingTrusted, setReconnectingTrusted] = useState(false);
  const [pendingCredentials, setPendingCredentials] = useState<{
    requestId: string;
    claimSecret: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inFlightPairRequestRef = useRef<{
    code: string;
    promise: Promise<{
      requestId: string;
      claimSecret: string;
      verificationCode: string;
      expiresAt: string;
    }>;
  } | null>(null);

  useEffect(() => {
    if (!initialPairingCode) {
      return;
    }
    let active = true;
    setPhase('submitting');
    setErrorMessage(null);

    if (inFlightPairRequestRef.current?.code !== initialPairingCode) {
      const effectiveName = loadSavedDeviceName();
      inFlightPairRequestRef.current = {
        code: initialPairingCode,
        promise: onRequestPairing({
          pairingCode: initialPairingCode,
          deviceName: effectiveName,
        }),
      };
    }

    void inFlightPairRequestRef.current.promise
      .then((res) => {
        if (!active) return;
        setVerificationCode(res.verificationCode);
        setPendingCredentials({
          requestId: res.requestId,
          claimSecret: res.claimSecret,
        });
        setPhase('waiting_approval');
      })
      .catch((err: unknown) => {
        if (!active) return;
        const code = (err as { code?: string }).code;
        setPhase(code === 'RATE_LIMITED' ? 'rate_limited' : 'error');
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Não foi possível validar o QR Code de pareamento.',
        );
      });

    return () => {
      active = false;
    };
  }, [initialPairingCode, onRequestPairing]);

  useEffect(() => {
    if (phase !== 'waiting_approval' || !pendingCredentials) {
      return;
    }

    let cancelled = false;
    const intervalId = setInterval(() => {
      void onPollPairing(pendingCredentials)
        .then((res) => {
          if (cancelled) return;
          if (res.status === 'approved' || res.status === 'claimed') {
            clearInterval(intervalId);
            onPaired();
          } else if (res.status === 'rejected') {
            clearInterval(intervalId);
            setPhase('rejected');
          } else if (res.status === 'expired') {
            clearInterval(intervalId);
            setPhase('expired');
          }
        })
        .catch(() => {
          // Keep polling until request expires or is resolved
        });
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [phase, pendingCredentials, onPollPairing, onPaired]);

  const statusNotice =
    sessionStatus === 'revoked'
      ? 'O acesso deste dispositivo foi revogado ou substituído por outro celular no computador.'
      : sessionStatus === 'expired'
        ? 'Sua sessão expirou por segurança. Escaneie um novo QR Code no computador.'
        : null;

  return (
    <div
      data-testid="mobile-pairing-gate"
      className="flex min-h-screen flex-col items-center justify-center bg-bg-base px-4 py-8 text-text-primary"
    >
      <div className="surface-card w-full max-w-md p-6">
        <div className="flex items-center gap-3 border-b border-border-subtle pb-4">
          <QrCode className="h-5 w-5 shrink-0 text-accent" strokeWidth={1.75} aria-hidden="true" />
          <div>
            <h1 className="font-sans text-base font-semibold text-text-primary">
              Pareamento Obrigatório — NUX MG-300
            </h1>
            <p className="font-sans text-xs text-text-muted">
              Apenas um celular autorizado pode controlar a pedaleira por vez.
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-4">
          {isTrustedDevice && onTrustedReconnect && phase === 'unpaired' ? (
            <div
              data-testid="trusted-device-reconnect-card"
              className="flex flex-col gap-2.5 rounded-[var(--radius-md)] border border-status-confirmed-border bg-status-confirmed-bg p-4"
            >
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-status-confirmed">
                Dispositivo Confiável Reconhecido
              </span>
              <p className="font-sans text-xs text-text-primary">
                {trustedDeviceName ? `${trustedDeviceName} já está` : 'Este aparelho já está'}{' '}
                na lista de dispositivos confiáveis. Reconecte sem ler o QR Code.
              </p>
              <button
                type="button"
                data-testid="trusted-reconnect-btn"
                disabled={reconnectingTrusted}
                onClick={() => {
                  setReconnectingTrusted(true);
                  setErrorMessage(null);
                  void onTrustedReconnect()
                    .catch((err: unknown) => {
                      setErrorMessage(
                        err instanceof Error
                          ? err.message
                          : 'Não foi possível reconectar como dispositivo confiável.',
                      );
                    })
                    .finally(() => setReconnectingTrusted(false));
                }}
                className="min-h-[44px] rounded-[var(--radius-md)] border border-status-confirmed-border bg-bg-recess px-4 font-sans text-xs font-semibold text-status-confirmed transition-colors duration-150 hover:border-status-confirmed disabled:opacity-50 cursor-pointer"
              >
                {reconnectingTrusted
                  ? 'Reconectando…'
                  : 'Reconectar (Dispositivo Confiável)'}
              </button>
            </div>
          ) : null}

          {statusNotice ? (
            <div
              data-testid="pairing-session-notice"
              className="rounded-[var(--radius-md)] border border-status-warning-border bg-status-warning-bg p-3 font-sans text-xs text-status-warning"
            >
              {statusNotice}
            </div>
          ) : null}

          {phase === 'submitting' ? (
            <div
              data-testid="pairing-submitting"
              className="rounded-[var(--radius-md)] border border-border-subtle bg-bg-recess p-4 text-center font-sans text-sm text-text-primary"
            >
              Validando QR Code com o computador…
            </div>
          ) : null}

          {phase === 'waiting_approval' && verificationCode ? (
            <div
              data-testid="pairing-waiting-approval"
              className="flex flex-col items-center gap-3 rounded-[var(--radius-md)] border border-status-warning-border bg-bg-recess p-4 text-center"
            >
              <span className="font-mono text-[11px] uppercase tracking-wider text-status-warning">
                Aguardando autorização no computador
              </span>
              <div
                data-testid="mobile-verification-code"
                className="rounded-[var(--radius-md)] border border-border-strong bg-bg-surface px-5 py-2.5 font-mono text-3xl font-bold tracking-[0.25em] text-text-primary tabular-nums"
              >
                {verificationCode}
              </div>
              <p className="font-sans text-xs leading-relaxed text-text-muted">
                Confirme no computador que o código acima corresponde ao exibido na tela e
                clique em <strong className="text-text-primary">Autorizar</strong>.
              </p>
              <span className="font-mono text-[11px] text-text-muted">
                Dispositivo: {deviceName}
              </span>
            </div>
          ) : null}

          {phase === 'rejected' ? (
            <div
              data-testid="pairing-rejected"
              className="rounded-[var(--radius-md)] border border-status-error-border bg-status-error-bg p-4 font-sans text-xs text-text-primary"
            >
              A solicitação de pareamento foi recusada no computador. Gere um novo QR Code
              caso deseje tentar novamente.
            </div>
          ) : null}

          {phase === 'expired' ? (
            <div
              data-testid="pairing-expired"
              className="rounded-[var(--radius-md)] border border-status-warning-border bg-status-warning-bg p-4 font-sans text-xs text-text-primary"
            >
              O tempo de aprovação expirou. Gere um novo QR Code no computador e escaneie
              novamente.
            </div>
          ) : null}

          {(phase === 'unpaired' || phase === 'error' || phase === 'rate_limited') &&
          errorMessage ? (
            <div
              data-testid="pairing-error"
              role="alert"
              className="rounded-[var(--radius-md)] border border-status-error-border bg-status-error-bg p-4 font-sans text-xs text-text-primary"
            >
              {errorMessage}
            </div>
          ) : null}

          {phase === 'unpaired' ||
          phase === 'rejected' ||
          phase === 'expired' ||
          phase === 'error' ||
          phase === 'rate_limited' ? (
            <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
              <p className="font-sans text-xs leading-relaxed text-text-muted">
                Por segurança, o acesso direto pelo IP não libera o controle da pedaleira.
                Para conectar este celular:
              </p>
              <ol className="list-inside list-decimal space-y-1.5 font-sans text-xs text-text-primary">
                <li>Abra o controlador no computador conectado à MG-300.</li>
                <li>
                  Clique em <strong className="font-semibold">Configurações</strong> e toque em{' '}
                  <strong className="font-semibold">Gerar QR Code</strong>.
                </li>
                <li>Aponte a câmera deste celular para o QR Code na tela.</li>
                <li>Autorize a conexão quando a solicitação aparecer no computador.</li>
              </ol>

              <div className="mt-1 flex flex-col gap-1.5 border-t border-border-subtle pt-3">
                <label
                  htmlFor="mobile-device-name"
                  className="font-mono text-[11px] uppercase tracking-wider text-text-muted"
                >
                  Nome deste dispositivo
                </label>
                <input
                  id="mobile-device-name"
                  name="device-name"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={deviceName}
                  maxLength={60}
                  onChange={(e) => {
                    const next = e.target.value.slice(0, 60);
                    setDeviceName(next);
                    saveDeviceName(next);
                  }}
                  className="min-h-[44px] rounded-[var(--radius-md)] border border-border-strong bg-bg-recess px-3 font-sans text-sm text-text-primary"
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
