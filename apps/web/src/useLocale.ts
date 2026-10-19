import { useSyncExternalStore } from 'react';
import { getLocale, getServerLocale, subscribeLocale } from './i18n.ts';

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, getServerLocale);
}
