// Lightweight i18n scaffold (gap #17). Replaces scattered hard-coded Chinese
// strings with a lookup table. Usage:
//   import { t, setLocale } from '@/i18n';
//   t('battery.charging')  -> '充电中' (zh) / 'Charging' (en)
//
// Migration plan: keep adding keys here and replace literals at call sites
// gradually. `locale` is persisted in SecureStore so it survives restarts.

import * as SecureStore from 'expo-secure-store';

export type Locale = 'zh' | 'en';

const DICT: Record<string, Record<Locale, string>> = {
  'battery.charging': { zh: '充电中', en: 'Charging' },
  'battery.locked': { zh: '已锁定', en: 'Locked' },
  'battery.unlocked': { zh: '未锁定', en: 'Unlocked' },
  'relay.online': { zh: '中继在线', en: 'Relay online' },
  'relay.offline': { zh: '离线', en: 'Offline' },
  'relay.board_connected': { zh: '保护板已连接', en: 'Board connected' },
  'settings.title': { zh: '设置', en: 'Settings' },
};

let current: Locale = 'zh';

export async function initLocale(): Promise<void> {
  const saved = await SecureStore.getItemAsync('locale');
  if (saved === 'zh' || saved === 'en') current = saved;
}

export function setLocale(locale: Locale): void {
  current = locale;
  SecureStore.setItemAsync('locale', locale).catch(() => {});
}

export function t(key: string): string {
  return DICT[key]?.[current] ?? key;
}
