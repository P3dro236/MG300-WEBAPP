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
      className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-status-warning-border bg-status-warning-bg p-4"
    >
      {pendingRequests.map((req, index) => {
        const isBusy = busyIds.has(req.requestId);
        return (
          <div
            key={req.requestId}
            data-testid={`pending-pairing-row-${req.requestId}`}
            className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"
          >
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-status-warning">
                  Solicitação de Acesso Mobile
                </span>
                <span className="rounded-[var(--radius-sm)] border border-border-subtle bg-bg-recess px-2 py-0.5 font-mono text-xs font-bold tracking-widest text-text-primary tabular-nums">
                  {req.verificationCode}
                </span>
              </div>
              <p className="font-sans text-xs text-text-primary">
                <strong>{req.deviceName}</strong> ({req.remoteIp}) deseja controlar a MG-300.
                Ao autorizar, qualquer outro celular conectado será desconectado.
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                data-testid={index === 0 ? 'reject-pairing-btn' : `reject-pairing-btn-${req.requestId}`}
                disabled={isBusy}
                onClick={() => runDecision(req.requestId, onReject)}
                className="min-h-[44px] rounded-[var(--radius-md)] border border-border-strong bg-bg-recess px-3.5 font-sans text-xs font-medium text-text-muted transition-colors duration-150 hover:border-border-hover hover:text-text-primary disabled:opacity-40 cursor-pointer"
              >
                Recusar
              </button>
              <button
                type="button"
                data-testid={index === 0 ? 'approve-pairing-btn' : `approve-pairing-btn-${req.requestId}`}
                disabled={isBusy}
                onClick={() => runDecision(req.requestId, onApprove)}
                className="min-h-[44px] rounded-[var(--radius-md)] border border-status-confirmed-border bg-status-confirmed-bg px-4 font-sans text-xs font-semibold text-status-confirmed transition-colors duration-150 hover:border-status-confirmed disabled:opacity-40 cursor-pointer"
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
