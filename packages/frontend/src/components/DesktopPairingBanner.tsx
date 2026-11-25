import React, { useState } from 'react';
import type { PendingPairingRequest } from '@quicktone/shared';

interface DesktopPairingBannerProps {
  pendingRequests: PendingPairingRequest[];
  onApprove: (requestId: string) => void | Promise<void>;
  onReject: (requestId: string) => void | Promise<void>;
}

export const DesktopPairingBanner: React.FC<DesktopPairingBannerProps> = ({
  pendingRequests,
  onApprove,
  onReject,
}) => {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());

  if (pendingRequests.length === 0) {
    return null;
  }

  const runDecision = (requestId: string, action: (id: string) => void | Promise<void>): void => {
    setBusyIds((prev) => new Set(prev).add(requestId));
    void Promise.resolve(action(requestId)).finally(() => {
      setBusyIds((prev) => {
        if (!prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    });
  };

  return (
    <section
      data-testid="desktop-pairing-banner"
      aria-label="Solicitações de pareamento mobile"
      className="flex flex-col gap-2 rounded-md border border-[#F59E0B]/45 bg-[#1B1710] p-3.5"
    >
      {pendingRequests.map((req) => {
        const isBusy = busyIds.has(req.requestId);
        return (
          <div
            key={req.requestId}
            data-testid={`pending-pairing-row-${req.requestId}`}
            className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"
          >
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#F59E0B]">
                  Solicitação de Acesso Mobile
                </span>
                <span className="rounded border border-white/10 bg-[#090A0C] px-2 py-0.5 font-mono text-xs font-bold tracking-widest text-[#F3F4F6] tabular-nums">
                  {req.verificationCode}
                </span>
              </div>
              <p className="font-sans text-xs text-[#F3F4F6]">
                <strong>{req.deviceName}</strong> ({req.remoteIp}) deseja controlar a MG-300.
                Ao autorizar, qualquer outro celular conectado será desconectado.
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                data-testid="reject-pairing-btn"
                disabled={isBusy}
                onClick={() => runDecision(req.requestId, onReject)}
                className="min-h-[44px] rounded border border-white/15 bg-[#090A0C] px-3.5 font-mono text-xs text-[#8E95A2] transition-colors duration-150 hover:border-white/30 hover:text-[#F3F4F6] disabled:opacity-40"
              >
                Recusar
              </button>
              <button
                type="button"
                data-testid="approve-pairing-btn"
                disabled={isBusy}
                onClick={() => runDecision(req.requestId, onApprove)}
                className="min-h-[44px] rounded border border-[#22C55E]/60 bg-[#141A16] px-4 font-mono text-xs font-semibold text-[#22C55E] transition-colors duration-150 hover:border-[#22C55E] disabled:opacity-40"
              >
                Autorizar Celular
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
};
