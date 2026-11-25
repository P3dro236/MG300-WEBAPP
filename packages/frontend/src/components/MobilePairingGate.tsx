import React, { useEffect, useRef, useState } from 'react';
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

  // Automatically submit pairing request when opened via QR Code URL (?pair=...)
  // Reusing the in-flight promise by code keeps StrictMode double-mount from consuming a single-use code twice.
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
        if (code === 'RATE_LIMITED') {
          setPhase('rate_limited');
        } else {
          setPhase('error');
        }
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

  // Poll desktop approval status while waiting
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
      className="flex min-h-screen flex-col items-center justify-center bg-[#0D0E10] px-4 py-8 text-[#F3F4F6]"
    >
      <div className="w-full max-w-md rounded-md border border-white/10 bg-[#14161A] p-5 sm:p-6">
        <div className="flex items-center gap-3 border-b border-white/[0.08] pb-4">
          <svg
            aria-hidden="true"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="shrink-0 text-[#F59E0B]"
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M14 14h3v3h-3zM18 17h3v4h-4v-3" />
          </svg>
          <div>
            <h1 className="font-sans text-base font-semibold text-[#F3F4F6]">
              Pareamento Obrigatório — NUX MG-300
            </h1>
            <p className="font-sans text-xs text-[#8E95A2]">
              Apenas um celular autorizado pode controlar a pedaleira por vez.
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-4">
          {isTrustedDevice && onTrustedReconnect && phase === 'unpaired' ? (
            <div
              data-testid="trusted-device-reconnect-card"
              className="flex flex-col gap-2.5 rounded border border-[#22C55E]/40 bg-[#141A16] p-4"
            >
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#22C55E]">
                Dispositivo Confiável Reconhecido
              </span>
              <p className="font-sans text-xs text-[#F3F4F6]">
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
                className="min-h-[44px] rounded border border-[#22C55E]/60 bg-[#090A0C] px-4 font-mono text-xs font-semibold text-[#22C55E] transition-colors duration-150 hover:border-[#22C55E] disabled:opacity-50"
              >
                {reconnectingTrusted
                  ? 'Reconectando...'
                  : 'Reconectar (Dispositivo Confiável)'}
              </button>
            </div>
          ) : null}

          {statusNotice ? (
            <div
              data-testid="pairing-session-notice"
              className="rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-3 font-sans text-xs text-[#F59E0B]"
            >
              {statusNotice}
            </div>
          ) : null}

          {phase === 'submitting' ? (
            <div
              data-testid="pairing-submitting"
              className="rounded border border-white/[0.08] bg-[#090A0C] p-4 text-center font-sans text-sm text-[#F3F4F6]"
            >
              Validando QR Code com o computador...
            </div>
          ) : null}

          {phase === 'waiting_approval' && verificationCode ? (
            <div
              data-testid="pairing-waiting-approval"
              className="flex flex-col items-center gap-3 rounded border border-[#F59E0B]/40 bg-[#090A0C] p-4 text-center"
            >
              <span className="font-mono text-[11px] uppercase tracking-wider text-[#F59E0B]">
                Aguardando autorização no computador
              </span>
              <div
                data-testid="mobile-verification-code"
                className="rounded border border-white/10 bg-[#14161A] px-5 py-2.5 font-mono text-3xl font-bold tracking-[0.25em] text-[#F3F4F6] tabular-nums"
              >
                {verificationCode}
              </div>
              <p className="font-sans text-xs leading-relaxed text-[#8E95A2]">
                Confirme no computador que o código acima corresponde ao exibido na tela e
                clique em <strong className="text-[#F3F4F6]">Autorizar</strong>.
              </p>
              <span className="font-mono text-[11px] text-[#8E95A2]">
                Dispositivo: {deviceName}
              </span>
            </div>
          ) : null}

          {phase === 'rejected' ? (
            <div
              data-testid="pairing-rejected"
              className="rounded border border-[#EF4444]/40 bg-[#EF4444]/10 p-4 font-sans text-xs text-[#F3F4F6]"
            >
              A solicitação de pareamento foi recusada no computador. Gere um novo QR Code
              caso deseje tentar novamente.
            </div>
          ) : null}

          {phase === 'expired' ? (
            <div
              data-testid="pairing-expired"
              className="rounded border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-4 font-sans text-xs text-[#F3F4F6]"
            >
              O tempo de aprovação expirou. Gere um novo QR Code no computador e escaneie
              novamente.
            </div>
          ) : null}

          {(phase === 'unpaired' || phase === 'error' || phase === 'rate_limited') &&
          errorMessage ? (
            <div
              data-testid="pairing-error"
              className="rounded border border-[#EF4444]/40 bg-[#EF4444]/10 p-4 font-sans text-xs text-[#F3F4F6]"
            >
              {errorMessage}
            </div>
          ) : null}

          {phase === 'unpaired' ||
          phase === 'rejected' ||
          phase === 'expired' ||
          phase === 'error' ||
          phase === 'rate_limited' ? (
            <div className="flex flex-col gap-3 rounded border border-white/[0.08] bg-[#090A0C] p-4">
              <p className="font-sans text-xs leading-relaxed text-[#8E95A2]">
                Por segurança, o acesso direto pelo IP não libera o controle da pedaleira.
                Para conectar este celular:
              </p>
              <ol className="list-inside list-decimal space-y-1.5 font-sans text-xs text-[#F3F4F6]">
                <li>Abra o controlador no computador conectado à MG-300.</li>
                <li>
                  Clique em <strong className="font-semibold">Ajustes</strong> e toque em{' '}
                  <strong className="font-semibold">Gerar QR Code de Pareamento</strong>.
                </li>
                <li>Aponte a câmera deste celular para o QR Code na tela.</li>
                <li>Autorize a conexão quando a solicitação aparecer no computador.</li>
              </ol>

              <div className="mt-1 flex flex-col gap-1.5 border-t border-white/[0.06] pt-3">
                <label
                  htmlFor="mobile-device-name"
                  className="font-mono text-[11px] uppercase tracking-wider text-[#8E95A2]"
                >
                  Nome deste dispositivo
                </label>
                <input
                  id="mobile-device-name"
                  type="text"
                  value={deviceName}
                  maxLength={60}
                  onChange={(e) => {
                    const next = e.target.value.slice(0, 60);
                    setDeviceName(next);
                    saveDeviceName(next);
                  }}
                  className="min-h-[44px] rounded border border-white/10 bg-[#14161A] px-3 font-sans text-sm text-[#F3F4F6] focus:border-white/25 focus:outline-none"
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
