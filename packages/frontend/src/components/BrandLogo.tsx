export interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
  className?: string;
}

const SIZE_CONFIG = {
  sm: {
    iconSize: 24,
    textClass: 'text-sm',
    gapClass: 'gap-2',
  },
  md: {
    iconSize: 28,
    textClass: 'text-base',
    gapClass: 'gap-2.5',
  },
  lg: {
    iconSize: 34,
    textClass: 'text-lg',
    gapClass: 'gap-3',
  },
} as const;

export function BrandLogo({
  size = 'md',
  showWordmark = true,
  className = '',
}: BrandLogoProps) {
  const { iconSize, textClass, gapClass } = SIZE_CONFIG[size];

  return (
    <span
      className={`inline-flex items-center shrink-0 whitespace-nowrap select-none ${gapClass} ${className}`.trim()}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden={showWordmark ? true : undefined}
        role={showWordmark ? undefined : 'img'}
        aria-label={showWordmark ? undefined : 'MG Control'}
        className="shrink-0"
      >
        <rect
          x="1.5"
          y="1.5"
          width="29"
          height="29"
          rx="5.5"
          fill="var(--bg-surface)"
          stroke="var(--border-strong)"
          strokeWidth="1.5"
        />
        <rect
          x="6"
          y="6.5"
          width="13"
          height="4.5"
          rx="1.2"
          fill="var(--bg-recess)"
          stroke="var(--text-primary)"
          strokeWidth="1.5"
        />
        <circle cx="24" cy="8.75" r="3.25" fill="var(--accent)" fillOpacity="0.18" />
        <circle cx="24" cy="8.75" r="2" fill="var(--accent)" />
        <circle
          cx="10.5"
          cy="20.5"
          r="4.25"
          fill="var(--bg-recess)"
          stroke="var(--text-primary)"
          strokeWidth="1.5"
        />
        <circle cx="10.5" cy="20.5" r="1.4" fill="var(--text-primary)" />
        <circle
          cx="21.5"
          cy="20.5"
          r="4.25"
          fill="var(--bg-recess)"
          stroke="var(--text-primary)"
          strokeWidth="1.5"
        />
        <circle cx="21.5" cy="20.5" r="1.4" fill="var(--text-primary)" />
      </svg>

      {showWordmark && (
        <span
          translate="no"
          className={`font-sans font-semibold tracking-tight text-text-primary leading-none whitespace-nowrap ${textClass}`}
        >
          MG Control
        </span>
      )}
    </span>
  );
}
