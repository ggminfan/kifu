import english from './en.json';

export type Locale = 'en' | 'zh-CN';
export type LanguagePreference = 'system' | Locale;
export const LANGUAGE_KEY = 'kifu.language';
const catalog: Record<string, string> = english;

/** Only the primary system language matters; Traditional Chinese uses English. */
export function detectLocale(language?: string): Locale {
  try {
    const locale = new Intl.Locale((language ?? '').replace(/_/g, '-')).maximize();
    return locale.language === 'zh' && locale.script === 'Hans' ? 'zh-CN' : 'en';
  } catch {
    return 'en';
  }
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || value === 'en' || value === 'zh-CN';
}

export function resolveLocale(preference: LanguagePreference, systemLanguage?: string): Locale {
  return preference === 'system' ? detectLocale(systemLanguage) : preference;
}

function browserPreference(): LanguagePreference {
  try {
    const value = localStorage.getItem(LANGUAGE_KEY);
    return isLanguagePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

declare global {
  interface Window { __KIFU_LANGUAGE__?: Locale }
}
let hostControlled = typeof window !== 'undefined' && isLanguagePreference(window.__KIFU_LANGUAGE__);
let preference: LanguagePreference = typeof window === 'undefined' ? 'system' : window.__KIFU_LANGUAGE__ ?? browserPreference();
let systemLanguage = typeof window === 'undefined' ? 'en' : navigator.languages?.[0] ?? navigator.language;
let locale = resolveLocale(preference, systemLanguage);
const listeners = new Set<() => void>();

export const getLocale = (): Locale => locale;
export const getLanguagePreference = (): LanguagePreference => preference;
export const subscribeLocale = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Used by the desktop host and by browser preferences; does not reload a page. */
export function configureLanguage(next: LanguagePreference, system = systemLanguage, persist = false): void {
  if (!isLanguagePreference(next)) return;
  const before = `${preference}:${locale}`;
  preference = next;
  systemLanguage = system;
  locale = resolveLocale(next, system);
  if (persist) {
    try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* private / restricted browser */ }
  }
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  if (before !== `${preference}:${locale}`) for (const listener of listeners) listener();
}

/** Source messages remain Chinese keys; interpolation values are never translated. */
export function translate(message: string, values: readonly unknown[] = [], language: Locale = locale): string {
  const template = language === 'en' ? catalog[message] ?? message : message;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : match);
}

export function tr(message: string): string;
export function tr(parts: TemplateStringsArray, ...values: unknown[]): string;
export function tr(message: string | TemplateStringsArray, ...values: unknown[]): string {
  if (typeof message === 'string') return translate(message);
  return translate(message.map((part, i) => part + (i < values.length ? `{${i}}` : '')).join(''), values);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const systemPatterns = Object.entries(catalog)
  .filter(([source]) => /\{\d+\}/.test(source))
  .sort(([a], [b]) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
  .map(([source, target]) => {
    const indices: number[] = [];
    let pattern = '^';
    let end = 0;
    for (const match of source.matchAll(/\{(\d+)\}/g)) {
      pattern += escapeRegExp(source.slice(end, match.index)) + '([\\s\\S]*?)';
      indices.push(Number(match[1]));
      end = match.index! + match[0].length;
    }
    return { regex: new RegExp(pattern + escapeRegExp(source.slice(end)) + '$'), indices, target };
  });

/** Only for Kifu-generated diagnostics. Never call on transcript or user-authored content. */
export function systemText(message: string | undefined): string {
  if (!message || locale === 'zh-CN') return message ?? '';
  if (Object.hasOwn(catalog, message)) return catalog[message];
  if (!/\p{Script=Han}/u.test(message)) return message;
  for (const { regex, indices, target } of systemPatterns) {
    const match = regex.exec(message);
    if (match) {
      const values: string[] = [];
      indices.forEach((index, position) => { values[index] = match[position + 1]; });
      return target.replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)] ?? '');
    }
  }
  return message;
}

/** Lazy static UI metadata: labels stay current after a language change. */
export function localized<T extends object>(source: T): T {
  const cache = new WeakMap<object, object>();
  const wrap = (value: object): object => {
    const existing = cache.get(value);
    if (existing) return existing;
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        const item: unknown = Reflect.get(target, key, receiver);
        if (typeof item === 'string') return tr(item);
        return item && typeof item === 'object' ? wrap(item) : item;
      },
    });
    cache.set(value, proxy);
    return proxy;
  };
  return wrap(source) as T;
}

if (typeof window !== 'undefined') {
  document.documentElement.lang = locale;
  window.addEventListener('languagechange', () => { if (!hostControlled) configureLanguage(preference, navigator.languages?.[0] ?? navigator.language); });
  window.addEventListener('kifu:language', (event) => {
    const value: unknown = (event as CustomEvent).detail;
    if (value === 'en' || value === 'zh-CN') { hostControlled = true; configureLanguage(value); }
  });
  window.addEventListener('storage', (event) => {
    if (!hostControlled && event.key === LANGUAGE_KEY) configureLanguage(browserPreference());
  });
}
