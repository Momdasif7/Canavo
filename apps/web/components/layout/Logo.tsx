export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <rect width="512" height="512" rx="112" fill="#C2410C" />
      <path d="M340 178a120 120 0 1 0 0 156" fill="none" stroke="#fff" strokeWidth="56" strokeLinecap="round" />
      <circle cx="356" cy="256" r="30" fill="#2D6A4F" />
    </svg>
  );
}
