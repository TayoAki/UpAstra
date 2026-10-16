/** UGCMediaClips mark: a stack of shorts, the front one playing with a caption bar. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="UGCMediaClips">
      <rect x="26" y="4" width="30" height="48" rx="7" fill="#ffc2c4" />
      <rect x="18" y="8" width="30" height="48" rx="7" fill="#ff8a8e" />
      <rect x="8" y="12" width="32" height="50" rx="7" fill="#e5484d" />
      <rect x="13" y="44" width="22" height="6" rx="3" fill="#fff" />
      <path d="M19 23l12 7-12 7z" fill="#fff" />
    </svg>
  );
}

/** Mark plus the wordmark, "Clips" in the accent colour. */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="brand-logo">
      <LogoMark size={size} />
      <span className="brand-word" style={{ fontSize: size * 0.53 }}>
        UGC Media <b>Clips</b>
      </span>
    </span>
  );
}
