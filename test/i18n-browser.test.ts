import { afterEach, expect, it, vi } from 'vitest';

function browser(language: string, saved?: string, embedded?: 'en' | 'zh-CN') {
  const events = new EventTarget();
  const values = new Map(saved ? [['kifu.language', saved]] : []);
  vi.stubGlobal('window', Object.assign(events, { __KIFU_LANGUAGE__: embedded }));
  vi.stubGlobal('navigator', { languages: [language, 'zh-CN'], language });
  vi.stubGlobal('document', { documentElement: { lang: '' } });
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  return { events, values };
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('defaults to the primary language, ignoring secondary Simplified Chinese', async () => {
  browser('zh-TW');
  const i18n = await import('../src/shared/i18n');
  expect(i18n.getLocale()).toBe('en');
  expect(document.documentElement.lang).toBe('en');
});

it('persists an explicit selection and restores it after a reload', async () => {
  const { values } = browser('en-US');
  const i18n = await import('../src/shared/i18n');
  i18n.configureLanguage('zh-CN', undefined, true);
  expect(values.get(i18n.LANGUAGE_KEY)).toBe('zh-CN');
  vi.resetModules();
  const restored = await import('../src/shared/i18n');
  expect(restored.getLocale()).toBe('zh-CN');
  expect(restored.getLanguagePreference()).toBe('zh-CN');
});

it('follows system changes only while system mode is selected', async () => {
  const { events } = browser('en-US');
  const i18n = await import('../src/shared/i18n');
  vi.stubGlobal('navigator', { languages: ['zh-Hans'], language: 'zh-Hans' });
  events.dispatchEvent(new Event('languagechange'));
  expect(i18n.getLocale()).toBe('zh-CN');
  i18n.configureLanguage('en');
  events.dispatchEvent(new Event('languagechange'));
  expect(i18n.getLocale()).toBe('en');
});

it('synchronizes other browser tabs and ignores invalid stored preferences', async () => {
  const { events, values } = browser('en-US', 'unsupported');
  const i18n = await import('../src/shared/i18n');
  expect(i18n.getLanguagePreference()).toBe('system');
  values.set(i18n.LANGUAGE_KEY, 'zh-CN');
  events.dispatchEvent(Object.assign(new Event('storage'), { key: i18n.LANGUAGE_KEY }));
  expect(i18n.getLocale()).toBe('zh-CN');
});

it('lets a desktop preload and host events override browser preferences', async () => {
  const { events, values } = browser('zh-CN', 'zh-CN', 'en');
  const i18n = await import('../src/shared/i18n');
  expect(i18n.getLocale()).toBe('en');
  events.dispatchEvent(Object.assign(new Event('storage'), { key: i18n.LANGUAGE_KEY }));
  events.dispatchEvent(new Event('languagechange'));
  expect(i18n.getLocale()).toBe('en');
  events.dispatchEvent(new CustomEvent('kifu:language', { detail: 'zh-CN' }));
  expect(i18n.getLocale()).toBe('zh-CN');
  events.dispatchEvent(new CustomEvent('kifu:language', { detail: '<script>' }));
  expect(i18n.getLocale()).toBe('zh-CN');
  expect(values.get(i18n.LANGUAGE_KEY)).toBe('zh-CN');
});
