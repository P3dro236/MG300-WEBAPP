import React from 'react';
import type { AppErrorRecord } from '@quicktone/shared';

interface ErrorBannerProps {
  error: AppErrorRecord | null;
  onDismiss: () => void;
}

function sanitizeUserErrorMessage(message: string): string {
  return message
    .replace(/\(\s*0x[0-9a-f]+\s*\)/gi, '')
    .replace(/\b0x[0-9a-f]+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({ error, onDismiss }) => {
  if (!error) {
    return null;
  }

  return (
    <div
      role="alert"
      data-testid="error-banner"
      data-error-code={error.code}
      className="flex items-start justify-between gap-3 rounded-md border border-[#EF4444]/45 bg-[#EF4444]/10 px-3.5 py-2.5 text-xs text-[#F3F4F6]"
    >
      <div className="flex items-start gap-2.5">
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="mt-0.5 shrink-0 text-[#EF4444]"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div className="font-sans text-xs text-[#F3F4F6]">
          {sanitizeUserErrorMessage(error.message)}
        </div>
      </div>

      <button
        type="button"
        data-testid="dismiss-error-btn"
        aria-label="Fechar aviso"
        onClick={onDismiss}
        className="min-h-[44px] shrink-0 rounded border border-white/10 bg-[#090A0C] px-3 py-1 font-mono text-[11px] text-[#8E95A2] hover:border-white/25 hover:text-[#F3F4F6] sm:min-h-[32px]"
      >
        Fechar
      </button>
    </div>
  );
};
