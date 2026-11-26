import React from 'react';
import { AlertCircle } from 'lucide-react';
import type { AppErrorRecord } from '@quicktone/shared';

interface ErrorBannerProps {
  error: AppErrorRecord | null;
  onDismiss: () => void;
  onRetry?: () => void;
}

function sanitizeUserErrorMessage(message: string): string {
  return message
    .replace(/\(\s*0x[0-9a-f]+\s*\)/gi, '')
    .replace(/\b0x[0-9a-f]+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({ error, onDismiss, onRetry }) => {
  if (!error) {
    return null;
  }

  const isPortBusy = error.code === 'PORT_BUSY';

  return (
    <div
      role="alert"
      data-testid="error-banner"
      data-error-code={error.code}
      className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-md)] border border-status-error-border bg-status-error-bg px-4 py-3 text-xs text-text-primary"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <AlertCircle
          className="mt-0.5 h-4 w-4 shrink-0 text-status-error"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="flex flex-col gap-1 font-sans text-xs text-text-primary">
          <span>{sanitizeUserErrorMessage(error.message)}</span>
          {isPortBusy ? (
            <span className="text-text-muted">
              Dica: feche o aplicativo oficial NUX QuickTone ou outro software MIDI antes de tentar novamente.
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {onRetry ? (
          <button
            type="button"
            data-testid="retry-error-btn"
            onClick={onRetry}
            className="min-h-[44px] rounded-[var(--radius-sm)] border border-status-error-border bg-bg-recess px-3 py-1 font-sans text-xs font-medium text-status-error transition-colors duration-150 hover:border-status-error lg:min-h-[34px] cursor-pointer"
          >
            Tentar novamente
          </button>
        ) : null}
        <button
          type="button"
          data-testid="dismiss-error-btn"
          aria-label="Fechar aviso"
          onClick={onDismiss}
          className="min-h-[44px] rounded-[var(--radius-sm)] border border-border-subtle bg-bg-recess px-3 py-1 font-sans text-xs text-text-muted transition-colors duration-150 hover:border-border-hover hover:text-text-primary lg:min-h-[34px] cursor-pointer"
        >
          Fechar
        </button>
      </div>
    </div>
  );
};
