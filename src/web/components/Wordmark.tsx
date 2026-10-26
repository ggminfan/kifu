import { BRAND_GOLD, PRODUCT_NAME, WORDMARK } from '../../shared/brand';

/** The drawn Kifu wordmark in the surrounding text colour, its spark in gold. */
export function Wordmark({ height = 14, className }: { height?: number; className?: string }) {
  return (
    <svg viewBox={WORDMARK.viewBox} height={height} width={(height * WORDMARK.width) / WORDMARK.height} className={className} role="img" aria-label={PRODUCT_NAME}>
      <g fill="currentColor">
        {WORDMARK.fills.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g fill="none" stroke="currentColor" strokeWidth={WORDMARK.stroke}>
        {WORDMARK.strokes.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <path d={WORDMARK.spark} fill={BRAND_GOLD} />
    </svg>
  );
}
