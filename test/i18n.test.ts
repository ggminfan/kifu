import { afterEach, describe, expect, it } from 'vitest';
import { configureLanguage, detectLocale, getLanguagePreference, getLocale, isLanguagePreference, localized, resolveLocale, subscribeLocale, systemText, tr, translate } from '../src/shared/i18n';
import english from '../src/shared/i18n/en.json';

afterEach(() => configureLanguage('system', 'en-US'));

describe('language selection', () => {
  it.each(['zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN', 'zh_Hans_SG', 'zh'])('uses Simplified Chinese for %s', (language) => {
    expect(detectLocale(language)).toBe('zh-CN');
  });
  it.each(['en-US', 'ja-JP', 'fr-FR', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-CN', '', 'invalid_locale_@'])('uses English for %s', (language) => {
    expect(detectLocale(language)).toBe('en');
  });
  it('honors explicit choices regardless of system language', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(isLanguagePreference('zh-TW')).toBe(false);
    expect(isLanguagePreference('system')).toBe(true);
  });
  it('notifies UI subscribers and supports returning to system mode', () => {
    configureLanguage('system', 'en-US');
    const changes: string[] = [];
    const unsubscribe = subscribeLocale(() => changes.push(`${getLanguagePreference()}:${getLocale()}`));
    configureLanguage('zh-CN', 'en-US');
    configureLanguage('system', 'en-US');
    configureLanguage('system', 'zh-Hans');
    unsubscribe();
    configureLanguage('en');
    expect(changes).toEqual(['zh-CN:zh-CN', 'system:en', 'system:zh-CN']);
  });
});

describe('message catalogs', () => {
  it('preserves every interpolation parameter in English', () => {
    const parameters = (value: string) => [...new Set(value.match(/\{\d+\}/g) ?? [])].sort();
    for (const [source, target] of Object.entries(english)) {
      expect(parameters(target), source).toEqual(parameters(source));
    }
  });
  it('does not translate or reinterpret interpolated user content', () => {
    configureLanguage('en');
    const userText = '用户输入 {1} <script>alert(1)</script>';
    expect(tr`已连接 ${userText}`).toBe(`Connected to ${userText}`);
    expect(translate('not in the catalog')).toBe('not in the catalog');
    expect(translate('会话', [], 'zh-CN')).toBe('会话');
  });
  it('updates static labels and nested arrays without reloading modules', () => {
    const labels = localized({ name: '会话', options: [{ label: '取消', id: 'cancel' }] });
    configureLanguage('en');
    expect(labels.name).toBe('Sessions');
    expect(labels.options[0].label).toBe('Cancel');
    expect(labels.options[0].id).toBe('cancel');
    configureLanguage('zh-CN');
    expect(labels.name).toBe('会话');
    expect(labels.options[0].label).toBe('取消');
  });
  it('localizes known generated diagnostics and leaves unknown text alone', () => {
    configureLanguage('en');
    expect(systemText('工作目录不存在：/tmp/中文项目')).toBe('Working directory not found: /tmp/中文项目');
    expect(systemText('这个文本来自用户，不是界面文案')).toBe('这个文本来自用户，不是界面文案');
    configureLanguage('zh-CN');
    expect(systemText('工作目录不存在：/tmp/中文项目')).toBe('工作目录不存在：/tmp/中文项目');
  });
});
