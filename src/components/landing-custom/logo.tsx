/**
 * Custom landing logo: three pipeline nodes on a diagonal in a mint square.
 * Pass a stable idSuffix (e.g. "-nav", "-footer") when it renders more than
 * once so gradient ids don't collide. Replace the contents to use your own
 * logo; navbar and footer don't need to change.
 */
export function Logo({
  size = 24,
  idSuffix = "",
}: {
  size?: number;
  idSuffix?: string;
}) {
  const gradientId = `custom-logo-grad${idSuffix}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.72 0.16 165)" />
          <stop offset="100%" stopColor="oklch(0.74 0.13 185)" />
        </linearGradient>
      </defs>
      <rect
        x="1.5"
        y="1.5"
        width="21"
        height="21"
        rx="6"
        fill={`url(#${gradientId})`}
      />
      <path
        d="M 6.5 17 L 12 12 L 17.5 7"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.45"
        fill="none"
      />
      <circle cx="6.5" cy="17" r="2" fill="white" />
      <circle cx="12" cy="12" r="2" fill="white" />
      <circle cx="17.5" cy="7" r="2" fill="white" />
    </svg>
  );
}
