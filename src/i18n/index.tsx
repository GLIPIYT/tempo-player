import { createContext, useContext, type ReactNode } from 'react'
import { useSettings } from '../state/settings'
import { ru } from './ru'
import { en } from './en'

export type Lang = 'ru' | 'en'

const dicts: Record<Lang, Record<string, string>> = { ru, en }

export function resolveLang(pref: 'ru' | 'en' | 'system'): Lang {
  if (pref !== 'system') return pref
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

const I18nContext = createContext<(key: string) => string>((k) => k)

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings()
  const lang = resolveLang(settings.lang)
  const dict = dicts[lang]
  const t = (key: string) => dict[key] ?? en[key] ?? key
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>
}

export function useT(): (key: string) => string {
  return useContext(I18nContext)
}
