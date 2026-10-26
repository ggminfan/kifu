import { useSyncExternalStore } from 'react';
import { configureLanguage, getLanguagePreference, getLocale, subscribeLocale, tr, type LanguagePreference } from './index';

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, () => `${getLanguagePreference()}:${getLocale()}`, () => 'system:en');
}

export function LanguageSelect({ value, onChange, className }: { value?: LanguagePreference; onChange?: (value: LanguagePreference) => void; className?: string }) {
  useLocale();
  return (
    <label className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span>{tr('语言')}</span>
      <select aria-label={tr('语言')} value={value ?? getLanguagePreference()} onChange={(event) => {
        const next = event.target.value as LanguagePreference;
        if (onChange) onChange(next);
        else configureLanguage(next, undefined, true);
      }} style={{ color: 'inherit', background: 'transparent', border: '1px solid #8886', borderRadius: 6, padding: '4px 6px', maxWidth: 190 }}>
        <option value="system">{tr('跟随系统')}</option>
        <option value="en">English</option>
        <option value="zh-CN">简体中文</option>
      </select>
    </label>
  );
}
