import { execFileSync } from 'node:child_process';
import { configureLanguage, detectLocale, isLanguagePreference, type LanguagePreference, type Locale } from '../../../../src/shared/i18n';

/** Finder launches do not reliably inherit LANG; AppleLanguages is authoritative on macOS. */
export function readSystemLanguage(): string {
  if (process.platform === 'darwin') {
    try {
      const languages = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      const primary = languages.match(/\(\s*"?([a-zA-Z][a-zA-Z0-9_-]*)/u)?.[1];
      if (primary) return primary;
    } catch { /* fall back to the runtime locale */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

export const systemLanguage = readSystemLanguage();
export const systemLocale: Locale = detectLocale(systemLanguage);

export function applyDesktopLanguage(value: unknown): LanguagePreference {
  const preference = isLanguagePreference(value) ? value : 'system';
  configureLanguage(preference, systemLanguage);
  return preference;
}
