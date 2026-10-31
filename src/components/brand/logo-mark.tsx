import { LANDING_VARIANT } from "@/config/landing";

/**
 * Default brand glyph by deployment mode: the LeadStack chevron stack in
 * "leadstack" mode, a neutral green "my CRM" badge in "custom" so no LeadStack
 * branding reaches a buyer's clients. Buyers swap in their own via logoUrl.
 */

interface LogoMarkProps {
  /** Square px size. */
  size?: number;
  className?: string;
  /** Unique suffix when several render on one page, so gradient ids don't collide across SSR + hydration. */
  idSuffix?: string;
}

export function LogoMark(props: LogoMarkProps) {
  if (LANDING_VARIANT === "custom") return <MyCrmMark {...props} />;
  return <ChevronStackMark {...props} />;
}

/** Buyer default badge; mirrors scripts/pwa-default-icon.svg. */
function MyCrmMark({ size = 20, className, idSuffix = "" }: LogoMarkProps) {
  const gradId = `mycrm-grad${idSuffix}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="55%" stopColor="#2dd4bf" />
          <stop offset="100%" stopColor="#6ee7b8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#18181b" />
      <text
        x="32"
        y="38"
        textAnchor="middle"
        fontFamily="inherit"
        fontWeight="700"
        fontSize="25"
        letterSpacing="0.5"
        fill={`url(#${gradId})`}
      >
        CRM
      </text>
      <rect x="19" y="44" width="26" height="4" rx="2" fill={`url(#${gradId})`} />
    </svg>
  );
}

/** Chevrons point left, right, left; alternating alignment reads as stacked cards. */
function ChevronStackMark({ size = 20, className, idSuffix = "" }: LogoMarkProps) {
  const id1 = `ls-mark-1${idSuffix}`;
  const id2 = `ls-mark-2${idSuffix}`;
  const id3 = `ls-mark-3${idSuffix}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id1} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
        <linearGradient id={id2} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <linearGradient id={id3} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#c026d3" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
      </defs>

      {/* Top: points left, right-aligned */}
      <path d="M 56 8 L 18 8 L 8 16 L 18 24 L 56 24 Z" fill={`url(#${id1})`} />

      {/* Middle: points right, left-aligned */}
      <path d="M 8 28 L 46 28 L 56 36 L 46 44 L 8 44 Z" fill={`url(#${id2})`} />

      {/* Bottom: points left, right-aligned */}
      <path d="M 56 48 L 18 48 L 8 56 L 18 60 L 56 60 Z" fill={`url(#${id3})`} />
    </svg>
  );
}
