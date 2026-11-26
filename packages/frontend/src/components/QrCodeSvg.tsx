import React, { useMemo } from 'react';
import { generateQrMatrix } from '../utils/qr-code';

interface QrCodeSvgProps {
  value: string;
  sizePx?: number;
  label?: string;
}

export const QrCodeSvg: React.FC<QrCodeSvgProps> = ({
  value,
  sizePx = 120,
  label,
}) => {
  const matrix = useMemo(() => generateQrMatrix(value), [value]);

  const pathData = useMemo(() => {
    if (!matrix) return '';
    const quiet = 4;
    const segments: string[] = [];
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        if (matrix.modules[r]?.[c]) {
          segments.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
        }
      }
    }
    return segments.join('');
  }, [matrix]);

  if (!matrix) {
    return (
      <div
        data-testid="qr-code-fallback"
        className="flex items-center justify-center rounded-[var(--radius-sm)] border border-border-subtle bg-bg-recess p-3 font-mono text-[11px] text-text-muted"
        style={{ width: sizePx, height: sizePx }}
      >
        URL muito longa
      </div>
    );
  }

  const total = matrix.size + 8;

  return (
    <svg
      data-testid="lan-qr-svg"
      role="img"
      aria-label={label ?? `QR Code para ${value}`}
      width={sizePx}
      height={sizePx}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      className="rounded-[var(--radius-sm)] border border-border-strong bg-text-primary"
    >
      <rect width={total} height={total} fill="var(--text-primary)" />
      <path d={pathData} fill="var(--bg-recess)" />
    </svg>
  );
};
