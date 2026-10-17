/** Pixel-style wordmark. */
export function Logo({ className = '' }: { className?: string }) {
  return (
    <span
      className={`font-pixel text-[28px] font-bold leading-none tracking-[0.04em] text-ink ${className}`}
      aria-label="ONB"
    >
      ONB
    </span>
  );
}
