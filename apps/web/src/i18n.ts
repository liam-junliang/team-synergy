import core from './locales/core.ts';
import workspace from './locales/workspace.ts';
import knowledge from './locales/knowledge.ts';
import execution from './locales/execution.ts';
import projectSwitcher from './locales/projectSwitcher.ts';
import permissions from './locales/permissions.ts';
import testing from './locales/testing.ts';
import skills from './locales/skills.ts';
import agentConnection from './locales/agentConnection.ts';
import admin from './locales/admin.ts';
import intake from './locales/intake.ts';

export type Locale = 'zh-CN' | 'en-US';
export const LOCALE_STORAGE_KEY = 'tsp:web:locale';
export const englishMessages: Readonly<Record<string, string>> = { ...workspace, ...knowledge, ...execution, ...projectSwitcher, ...permissions, ...testing, ...skills, ...core, ...agentConnection, ...admin, ...intake };
type Parameters = Record<string, string | number>;
let currentLocale: Locale = 'zh-CN';
const listeners = new Set<() => void>();

export function resolveLocale(saved: string | null, languages: readonly string[] = []): Locale {
  if (saved === 'zh-CN' || saved === 'en-US') return saved;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en-US';
  }
  return 'zh-CN';
}

export function translate(locale: Locale, message: string, parameters: Parameters = {}): string {
  const template = locale === 'en-US' && Object.hasOwn(englishMessages, message) ? englishMessages[message] : message;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(parameters, key)) return match;
    const value = parameters[key];
    return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : value;
  });
}

export function t(message: string, parameters?: Parameters): string {
  return translate(currentLocale, message, parameters);
}

export function getLocale(): Locale { return currentLocale; }
export function getServerLocale(): Locale { return currentLocale; }
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function updateDocument(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = currentLocale;
  document.title = `Team Synergy · ${t('项目协作工作台')}`;
}

export function setLocale(locale: Locale, persist = true): void {
  if (locale !== 'zh-CN' && locale !== 'en-US') return;
  if (persist && typeof window !== 'undefined') {
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Storage may be disabled. */ }
  }
  const changed = currentLocale !== locale;
  currentLocale = locale;
  updateDocument();
  if (changed) listeners.forEach((listener) => listener());
}

/** Initialize once at the application entry point, keeping imports safe in SSR and tests. */
export function initializeLocale(): () => void {
  if (typeof window === 'undefined') return () => {};
  const languages = window.navigator.languages ?? [window.navigator.language];
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(LOCALE_STORAGE_KEY); } catch { /* In-memory switching still works. */ }
  setLocale(resolveLocale(saved, languages), false);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCALE_STORAGE_KEY || event.key === null) {
      setLocale(resolveLocale(event.newValue, languages), false);
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

function dateValue(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  // Calendar dates must not shift to the previous day in western time zones.
  return new Date(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
}

export function formatDate(value: string | number | Date | null | undefined, options?: Intl.DateTimeFormatOptions, locale: Locale = currentLocale): string {
  if (value == null || value === '') return '—';
  const date = dateValue(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatDateTime(value: string | number | Date | null | undefined, options?: Intl.DateTimeFormatOptions, locale: Locale = currentLocale): string {
  return formatDate(value, options ?? { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }, locale);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions, locale: Locale = currentLocale): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function systemFolderName(folder: { name: string; system_role?: string | null }): string {
  switch (folder.system_role) {
    case 'standards': return t('项目规范');
    case 'requirements': return t('需求文档');
    case 'architecture': return t('架构设计');
    case 'testing': return t('测试资料');
    default: return folder.name;
  }
}
