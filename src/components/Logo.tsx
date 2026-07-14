/** The Gift mark: a popped-open box whose bow became a star. Keyline strokes
 *  assume the app's #100b14 background. Decorative — pages carry the name in text. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id="gift-logo-g" x1="32" y1="0" x2="32" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffdfa3" />
          <stop offset=".55" stopColor="#fb7185" />
          <stop offset="1" stopColor="#e11d48" />
        </linearGradient>
        <radialGradient id="gift-logo-halo" cx="32" cy="13.5" r="13" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffe9c4" stopOpacity=".22" />
          <stop offset="1" stopColor="#ffe9c4" stopOpacity="0" />
        </radialGradient>
        <path id="gift-logo-spark" d="M0 -8.5 C.6 -3.4 3.4 -.6 8.5 0 C3.4 .6 .6 3.4 0 8.5 C-.6 3.4 -3.4 .6 -8.5 0 C-3.4 -.6 -.6 -3.4 0 -8.5 Z" />
      </defs>
      <circle cx="32" cy="13.5" r="13" fill="url(#gift-logo-halo)" />
      <path fill="url(#gift-logo-g)" d="M29.25 22 L17 22 Q13 22 13 26 Q13 30 17 30 L29.25 30 Z" />
      <path fill="url(#gift-logo-g)" d="M34.75 22 L47 22 Q51 22 51 26 Q51 30 47 30 L34.75 30 Z" />
      <path fill="url(#gift-logo-g)" d="M29.25 33 L22 33 Q17 33 17 38 L17 48 Q17 53 22 53 L29.25 53 Z" />
      <path fill="url(#gift-logo-g)" d="M34.75 33 L42 33 Q47 33 47 38 L47 48 Q47 53 42 53 L34.75 53 Z" />
      <g fill="url(#gift-logo-g)" stroke="#100b14" strokeWidth="2" paintOrder="stroke">
        <use href="#gift-logo-spark" transform="translate(32 13.5)" />
        <use href="#gift-logo-spark" transform="translate(47.5 8) scale(.36)" />
        <circle cx="17.5" cy="7.5" r="1.5" />
      </g>
    </svg>
  );
}
