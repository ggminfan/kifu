/**
 * MIT-licensed rendering code. Imported artwork and rendered Kifu marks are
 * separately licensed under TRADEMARKS.md (Copyright (c) 2026 Liam).
 * The product's name and mark, for the desktop shell, the web UI and the app icon.
 *
 * Kifu (棋谱) is a game record: an agent session is one, and the app replays it move by move.
 */

import brandArtwork from './brand-artwork.json';

export const PRODUCT_NAME = 'Kifu';
export const PRODUCT_AUTHOR = 'Liam';
export const PRODUCT_COPYRIGHT = 'Copyright © 2026 Liam';
export const PRODUCT_LICENSE = 'MIT';
export const PRODUCT_NAME_ZH = '棋谱';
export const TAGLINE = '每一步都看得见，每一手都能重下';

/** Brand artwork is separately licensed under TRADEMARKS.md; this renderer is MIT. */
export const WORDMARK = brandArtwork.wordmark;

const SPARK_GOLD = '#F2B33D';

/** A spark (four-point star) centred at x, y with radius r. */
function sparkPath(x: number, y: number, r: number): string {
  const k = r * 0.16;
  const f = (n: number) => +n.toFixed(1);
  return `M${f(x)} ${f(y - r)}Q${f(x + k)} ${f(y - k)} ${f(x + r)} ${f(y)}Q${f(x + k)} ${f(y + k)} ${f(x)} ${f(y + r)}Q${f(x - k)} ${f(y + k)} ${f(x - r)} ${f(y)}Q${f(x - k)} ${f(y - k)} ${f(x)} ${f(y - r)}Z`;
}

/**
 * The app icon (macOS template: an 824 rounded square inside a 1024 canvas). Full: the wordmark;
 * small (32 pt and below, where four letters would blur): K and the spark. `crop` trims the canvas
 * to the rounded square, for page headers and the browser tab. `pnpm icons` renders the full and
 * the small icon into desktop/assets/Kifu.iconset.
 */
export function appIconSvg({ small = false, crop = false }: { small?: boolean; crop?: boolean } = {}): string {
  const letters = WORDMARK.fills.map((d, i) => (small && !(WORDMARK.k.fills as readonly number[]).includes(i) ? '' : `<path d="${d}"/>`)).join('');
  const strokes = small ? '' : WORDMARK.strokes.map((d) => `<path d="${d}"/>`).join('');
  // full: the wordmark 640 wide, centred; small: the K 446 high with the spark at its shoulder
  const mark = small
    ? { tx: 268, ty: 296, s: 0.62, spark: sparkPath(708, 66, 94), glow: { x: 268 + 708 * 0.62, y: 296 + 66 * 0.62 } }
    : { tx: 192, ty: 382, s: 0.372, spark: WORDMARK.spark, glow: { x: 192 + 711 * 0.372, y: 382 + 66 * 0.372 } };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="${crop ? '100 100 824 824' : '0 0 1024 1024'}">`,
    '<defs>',
    '<clipPath id="kf-sq"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>',
    '<linearGradient id="kf-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2D2E36"/><stop offset="1" stop-color="#16171B"/></linearGradient>',
    '<linearGradient id="kf-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".09"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>',
    `<radialGradient id="kf-glow" gradientUnits="userSpaceOnUse" cx="${mark.glow.x.toFixed(0)}" cy="${mark.glow.y.toFixed(0)}" r="${small ? 230 : 190}"><stop offset="0" stop-color="${SPARK_GOLD}" stop-opacity=".34"/><stop offset="1" stop-color="${SPARK_GOLD}" stop-opacity="0"/></radialGradient>`,
    '<linearGradient id="kf-spark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF2C9"/><stop offset=".55" stop-color="#F6C356"/><stop offset="1" stop-color="#E99D21"/></linearGradient>',
    crop ? '' : '<filter id="kf-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity=".3"/></filter>',
    '</defs>',
    `<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#kf-bg)"${crop ? '' : ' filter="url(#kf-shadow)"'}/>`,
    '<g clip-path="url(#kf-sq)"><rect x="100" y="100" width="824" height="824" fill="url(#kf-glow)"/><rect x="100" y="100" width="824" height="380" fill="url(#kf-sheen)"/></g>',
    `<g transform="translate(${mark.tx} ${mark.ty}) scale(${mark.s})">`,
    `<g fill="#F6F4EF">${letters}</g>`,
    strokes ? `<g fill="none" stroke="#F6F4EF" stroke-width="${WORDMARK.stroke}">${strokes}</g>` : '',
    `<path d="${mark.spark}" fill="url(#kf-spark)"/>`,
    '</g>',
    `<rect x="101.5" y="101.5" width="821" height="821" rx="185" fill="none" stroke="#FFFFFF" stroke-opacity=".1" stroke-width="3"/>`,
    '</svg>',
  ].join('');
}

/** The small icon, cropped to its rounded square: page headers, the browser tab, Settings → 关于 at small sizes. */
export const PRODUCT_ICON = `data:image/svg+xml,${encodeURIComponent(appIconSvg({ small: true, crop: true }))}`;
/** The full icon (the wordmark), cropped: About pages and anywhere 64 px or larger. */
export const PRODUCT_ICON_FULL = `data:image/svg+xml,${encodeURIComponent(appIconSvg({ crop: true }))}`;
/** The spark's colour, for wordmarks drawn in the page's own text colour. */
export const BRAND_GOLD = SPARK_GOLD;
