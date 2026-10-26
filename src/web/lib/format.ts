import { getLocale } from '../../shared/i18n';
import { tr } from '../../shared/i18n';
import type { Usage } from '../../shared/types';

export function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '–';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function fmtUsage(u: Usage | undefined): string {
  if (!u) return tr("无用量");
  const parts = [`${fmtTokens(u.input)} in`, `${fmtTokens(u.output)} out`];
  if (u.cached) parts.push(`${fmtTokens(u.cached)} cached`);
  return parts.join(' / ');
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${Math.round(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function relTime(ms: number | undefined): string {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return tr("刚刚");
  if (d < 3_600_000) return tr`${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return tr`${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return tr`${Math.floor(d / 86_400_000)} 天前`;
  const date = new Date(ms);
  return tr`${date.getMonth() + 1}月${date.getDate()}日`;
}

export function fmtTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString(getLocale(), { hour12: false });
}

/**
 * A short id people can tell apart. Session ids are time-ordered (UUID v7):
 * ids from the same day share their first characters, so the end is shown.
 */
export function shortId(id: string | undefined): string {
  if (!id) return '';
  return id.length > 12 ? `…${id.replace(/-/g, '').slice(-6)}` : id;
}

export function basename(p: string | undefined): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function spanMs(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : undefined;
}

export { firstLine } from '../../shared/tools';

export function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * JSON indented like `JSON.stringify(v, null, 2)`, except that strings with
 * line breaks (tool outputs, AGENTS.md, skill lists …) are shown on their own
 * lines between `"""` instead of as one line of `\n` escapes. For reading only:
 * it is not JSON. Other control characters stay escaped (visible).
 */
export function readableJson(value: unknown, indent = ''): string {
  const inner = `${indent}  `;
  if (typeof value === 'string') {
    if (!value.includes('\n')) return JSON.stringify(value);
    // eslint-disable-next-line no-control-regex
    const shown = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (ch) => JSON.stringify(ch).slice(1, -1));
    return `"""\n${shown.split('\n').map((l) => (l ? inner + l : l)).join('\n')}\n${inner}"""`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => inner + readableJson(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${readableJson(v, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
