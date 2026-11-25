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

  if (!matrix) {
    return (
      <div
        data-testid="qr-code-fallback"
        className="flex items-center justify-center border border-white/10 bg-[#090A0C] p-3 font-mono text-[11px] text-[#8E95A2]"
        style={{ width: sizePx, height: sizePx }}
      >
        URL muito longa
      </div>
    );
  }

  const quiet = 4;
  const total = matrix.size + quiet * 2;
  const rects: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r]?.[c]) {
        rects.push({ x: c + quiet, y: r + quiet });
      }
    }
  }

  return (
    <svg
      data-testid="lan-qr-svg"
      role="img"
      aria-label={label ?? `QR Code para ${value}`}
      width={sizePx}
      height={sizePx}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      className="rounded border border-white/15 bg-[#F3F4F6]"
    >
      <rect width={total} height={total} fill="#F3F4F6" />
      {rects.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={cell.x}
          y={cell.y}
          width={1}
          height={1}
          fill="#0D0E10"
        />
      ))}
    </svg>
  );
};
