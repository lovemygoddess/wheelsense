import { NativeModules, Platform } from 'react-native';
import type { ResolvedThemeMode, ThemeColors, ThemeMode, WidgetThemeBehavior } from './themePacks';
import { isDemoModeSync } from './demo/demoStore';

const { WidgetDataModule } = NativeModules;
const DEMO_WIDGET_PREFIX = 'demo_';

export interface WidgetData {
  widget_battery_pct: number;
  widget_voltage: number;
  widget_temperature: number;
  widget_range: number;
  widget_charging: boolean;
  widget_vehicle_name: string;
  widget_health_score: number;
  widget_locked: number;
  widget_remain_charge: number;
}

export async function saveWidgetData(data: Partial<WidgetData>): Promise<boolean> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.saveWidgetData) return false;
  try {
    await WidgetDataModule.saveWidgetData(data);
    return true;
  } catch {
    return false;
  }
}

/** Store the demo snapshot in a separate native preference namespace. */
export async function saveDemoWidgetData(data: Record<string, string | number | boolean>): Promise<boolean> {
  if (Platform.OS === 'android' && WidgetDataModule?.setDemoMode) {
    try {
      await WidgetDataModule.setDemoMode(true, data);
      return true;
    } catch { /* fallback below for older native installs */ }
  }
  const snapshot = Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => key !== 'demo_mode_enabled' && key !== 'widget_demo_mode')
      .map(([key, value]) => [`${DEMO_WIDGET_PREFIX}${key}`, value]),
  ) as Record<string, string | number | boolean>;
  snapshot.demo_mode_enabled = true;
  snapshot.widget_demo_mode = true;
  return saveWidgetData(snapshot as Partial<WidgetData>);
}

/** Clear the native demo namespace and immediately return the widget to real data. */
export async function clearDemoWidgetData(): Promise<boolean> {
  if (Platform.OS === 'android' && WidgetDataModule?.setDemoMode) {
    try {
      await WidgetDataModule.setDemoMode(false, null);
      return true;
    } catch { /* fallback below for older native installs */ }
  }
  return saveWidgetData({ demo_mode_enabled: false, widget_demo_mode: false } as any);
}

export async function getSavedWidgetData(): Promise<Record<string, unknown>> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.getSavedWidgetData) return {};
  try {
    return await WidgetDataModule.getSavedWidgetData();
  } catch {
    return {};
  }
}

/** Widget auto-refresh interval (minutes), persisted in the provider's prefs. */
export async function setWidgetRefreshInterval(minutes: number): Promise<boolean> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.setRefreshInterval) return false;
  try {
    await WidgetDataModule.setRefreshInterval(minutes);
    return true;
  } catch {
    return false;
  }
}

export async function getWidgetRefreshInterval(): Promise<number> {
  const data = await getSavedWidgetData();
  const v = Number(data['widget_refresh_min']);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 30;
}

export interface WidgetThemeBridgePayload {
  themePackId: string; themeMode: ThemeMode; resolvedMode: ResolvedThemeMode;
  behavior: WidgetThemeBehavior; dialogueEnabled: boolean; colors: ThemeColors;
  lightColors: ThemeColors; darkColors: ThemeColors;
  widgetStyle: 'tech' | 'character'; glowOpacity: number; characterAssetName?: string | null;
  characterMaxFraction: number;
  characterCropTop: number; characterCropBottom: number;
  decorationAssetName?: string | null; backgroundAssetName?: string | null;
}

/** Mirrors only the lightweight native renderer contract; artwork remains optional. */
export async function syncWidgetTheme(payload: WidgetThemeBridgePayload): Promise<boolean> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.saveWidgetData) return false;
  const c = payload.colors;
  const putPalette = (prefix: string, palette: ThemeColors) => ({
    [`${prefix}_primary`]: palette.primary, [`${prefix}_primary_soft`]: palette.primarySoft,
    [`${prefix}_background`]: palette.background, [`${prefix}_surface`]: palette.surface,
    [`${prefix}_surface_secondary`]: palette.surfaceSecondary, [`${prefix}_border`]: palette.border,
    [`${prefix}_text_primary`]: palette.textPrimary, [`${prefix}_text_secondary`]: palette.textSecondary,
    [`${prefix}_text_muted`]: palette.textMuted, [`${prefix}_warning`]: palette.warning, [`${prefix}_danger`]: palette.danger,
  });
  return saveWidgetData({
    widget_theme_pack_id: payload.themePackId,
    widget_theme_mode: payload.themeMode,
    widget_resolved_mode: payload.resolvedMode,
    widget_theme_behavior: payload.behavior,
    widget_dialogue_enabled: payload.dialogueEnabled,
    widget_skin_style: payload.widgetStyle,
    widget_glow_opacity: payload.glowOpacity,
    widget_character_max_fraction: payload.characterMaxFraction,
    widget_character_crop_top: payload.characterCropTop,
    widget_character_crop_bottom: payload.characterCropBottom,
    widget_color_primary: c.primary,
    widget_color_primary_soft: c.primarySoft,
    widget_color_background: c.background,
    widget_color_surface: c.surface,
    widget_color_surface_secondary: c.surfaceSecondary,
    widget_color_border: c.border,
    widget_color_text_primary: c.textPrimary,
    widget_color_text_secondary: c.textSecondary,
    widget_color_text_muted: c.textMuted,
    widget_color_warning: c.warning,
    widget_color_danger: c.danger,
    ...putPalette('widget_light', payload.lightColors),
    ...putPalette('widget_dark', payload.darkColors),
    widget_asset_character: payload.characterAssetName ?? '',
    widget_asset_decoration: payload.decorationAssetName ?? '',
    widget_asset_background: payload.backgroundAssetName ?? '',
  } as unknown as Partial<WidgetData>);
}

/* ------------------------------------------------------------------ */
/* Local event notifications (driven by the widget refresh chain)      */
/* ------------------------------------------------------------------ */

export interface NotificationPrefs {
  chargeStart: boolean;
  chargeEnd: boolean;
  tempHigh: boolean;
  ezvizAlarm: boolean;
  lowBattery: boolean;
}

const NOTIFY_KEYS: Record<keyof NotificationPrefs, string> = {
  chargeStart: 'notify_charge_start',
  chargeEnd: 'notify_charge_end',
  tempHigh: 'notify_temp_high',
  ezvizAlarm: 'notify_ezviz_alarm',
  lowBattery: 'notify_low_battery',
};

/** All toggles default to ON — the user opted into a monitoring app. */
export async function getNotificationPrefs(): Promise<NotificationPrefs> {
  const data = await getSavedWidgetData();
  const read = (k: string) => data[k] !== false; // missing key → true
  return {
    chargeStart: read(NOTIFY_KEYS.chargeStart),
    chargeEnd: read(NOTIFY_KEYS.chargeEnd),
    tempHigh: read(NOTIFY_KEYS.tempHigh),
    ezvizAlarm: read(NOTIFY_KEYS.ezvizAlarm),
    lowBattery: read(NOTIFY_KEYS.lowBattery),
  };
}

export async function setNotificationPref(key: keyof NotificationPrefs, value: boolean): Promise<boolean> {
  return saveWidgetData({ [NOTIFY_KEYS[key]]: value } as Partial<WidgetData>);
}

export async function hasNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.hasNotificationPermission) return true;
  try {
    return !!(await WidgetDataModule.hasNotificationPermission());
  } catch {
    return false;
  }
}

/** Fires the Android 13+ system prompt (no-op below 33). Re-check state on focus. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.requestNotificationPermission) return true;
  try {
    return !!(await WidgetDataModule.requestNotificationPermission());
  } catch { return false; }
}

export async function openNotificationSettings(): Promise<void> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.openNotificationSettings) return;
  try { await WidgetDataModule.openNotificationSettings(); } catch { /* ignore */ }
}

export async function refreshNotificationsNow(): Promise<boolean> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.refreshWidgetNow) return false;
  try { return !!(await WidgetDataModule.refreshWidgetNow()); } catch { return false; }
}

export async function sendTestNotification(): Promise<boolean> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.sendTestNotification) return false;
  try { return !!(await WidgetDataModule.sendTestNotification()); } catch { return false; }
}

export interface NotificationHealth {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextCheckAt: number | null;
  lastError: string | null;
}

export async function getNotificationHealth(): Promise<NotificationHealth> {
  const data = await getSavedWidgetData();
  const stamp = (key: string) => {
    const value = Number(data[key]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    lastAttemptAt: stamp('notify_last_attempt_at'),
    lastSuccessAt: stamp('notify_last_success_at'),
    nextCheckAt: stamp('notify_next_check_at'),
    lastError: typeof data['notify_last_error'] === 'string' ? data['notify_last_error'] : null,
  };
}

/* ------------------------------------------------------------------ */
/* App-level preferences (mirrored into the widget's SharedPreferences */
/* so the native notification chain can read the threshold values).     */
/* Keys are prefixed app_*; the two notification-relevant thresholds    */
/* are ALSO written under notify_* keys the Kotlin side reads directly. */
/* ------------------------------------------------------------------ */

const APP_KEYS = {
  homeRefreshSec: 'app_home_refresh_sec',
  tipEnabled: 'app_tip_enabled',
  tipAnomaly: 'app_tip_anomaly',
  tipSmart: 'app_tip_smart',
  tipWeather: 'app_tip_weather',
  lowBatteryPct: 'app_low_battery_pct',
  tempWarnC: 'app_temp_warn_c',
  tempDangerC: 'app_temp_danger_c',
  mapZoom: 'app_map_zoom',
  gpsSpeed: 'app_gps_speed_enabled',
} as const;

const NATIVE_TEMP_WARN = 'notify_temp_warn';
const NATIVE_LOW_BATTERY_PCT = 'notify_low_battery_pct';

async function getAppNumber(key: string, def: number): Promise<number> {
  const data = await getSavedWidgetData();
  const v = Number(data[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

async function getAppBool(key: string, def: boolean): Promise<boolean> {
  const data = await getSavedWidgetData();
  return data[key] === undefined ? def : !!data[key];
}

async function setAppRaw(key: string, value: number | boolean): Promise<void> {
  await saveWidgetData({ [key]: value } as unknown as Partial<WidgetData>);
}

/* 首页自动刷新间隔（秒）。九号云端数据默认每 5 分钟更新一次。 */
export async function getHomeRefreshSec(): Promise<number> {
  const v = await getAppNumber(APP_KEYS.homeRefreshSec, 300);
  return [60, 300, 600, 900].includes(v) ? v : 300;
}
export async function setHomeRefreshSec(sec: number): Promise<void> {
  await setAppRaw(APP_KEYS.homeRefreshSec, sec);
}

/* 首页动态提示开关：总开关 + 异常/智能/天气 三类。默认全开。 */
export interface TipPrefs { enabled: boolean; anomaly: boolean; smart: boolean; weather: boolean; }
export async function getTipPrefs(): Promise<TipPrefs> {
  return {
    enabled: await getAppBool(APP_KEYS.tipEnabled, true),
    anomaly: await getAppBool(APP_KEYS.tipAnomaly, true),
    smart: await getAppBool(APP_KEYS.tipSmart, true),
    weather: await getAppBool(APP_KEYS.tipWeather, true),
  };
}
export async function setTipPref(key: keyof TipPrefs, value: boolean): Promise<void> {
  await setAppRaw(APP_KEYS[`tip${key.charAt(0).toUpperCase()}${key.slice(1)}` as keyof typeof APP_KEYS], value);
}

/* 低电量阈值（%），默认 10；同时镜像到原生 notify_low_battery_pct 供通知用。 */
export async function getLowBatteryPct(): Promise<number> {
  return getAppNumber(APP_KEYS.lowBatteryPct, 10);
}
export async function setLowBatteryPct(pct: number): Promise<void> {
  await setAppRaw(APP_KEYS.lowBatteryPct, pct);
  await setAppRaw(NATIVE_LOW_BATTERY_PCT, pct);
}

/* 高温预警 / 严重过热阈值（°C），默认 40 / 45。高温预警镜像到原生 notify_temp_warn。 */
export async function getTempWarnC(): Promise<number> {
  return getAppNumber(APP_KEYS.tempWarnC, 40);
}
export async function setTempWarnC(c: number): Promise<void> {
  await setAppRaw(APP_KEYS.tempWarnC, c);
  await setAppRaw(NATIVE_TEMP_WARN, c);
}
export async function getTempDangerC(): Promise<number> {
  return getAppNumber(APP_KEYS.tempDangerC, 45);
}
export async function setTempDangerC(c: number): Promise<void> {
  await setAppRaw(APP_KEYS.tempDangerC, c);
}

/* 首页静态地图缩放级别，默认 15。 */
export async function getMapZoom(): Promise<number> {
  const v = await getAppNumber(APP_KEYS.mapZoom, 15);
  return [12, 15, 18].includes(v) ? v : 15;
}
export async function setMapZoom(z: number): Promise<void> {
  await setAppRaw(APP_KEYS.mapZoom, z);
}

/* 仪表板 GPS 实时车速开关：默认关闭（室内飘速 + 省电）。关闭时 App 任何页面
 * 都不发起定位/GNSS 调用；开启后也仅仪表板页前台时采样。 */
export async function getGpsSpeedEnabled(): Promise<boolean> {
  return getAppBool(APP_KEYS.gpsSpeed, false);
}
export async function setGpsSpeedEnabled(v: boolean): Promise<void> {
  await setAppRaw(APP_KEYS.gpsSpeed, v);
}

/* ------------------------------------------------------------------ */
/* Exact-alarm permission (widget background auto-refresh on Android 12+) */
/* ------------------------------------------------------------------ */

/**
 * Whether the widget can use exact alarms (`setExactAndAllowWhileIdle`) so it
 * refreshes on time even under Doze. On Android 12+ this needs the
 * "Alarms & reminders" special permission (SCHEDULE_EXACT_ALARM), which is off
 * by default. Non-Android and pre-Android-12 always return true.
 */
export async function canScheduleExactAlarm(): Promise<boolean> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.canScheduleExactAlarm) return true;
  try {
    return !!(await WidgetDataModule.canScheduleExactAlarm());
  } catch {
    return true;
  }
}

/** Open the per-app "Alarms & reminders" settings page to grant the permission. */
export async function openExactAlarmSettings(): Promise<void> {
  if (Platform.OS !== 'android' || !WidgetDataModule?.openExactAlarmSettings) return;
  try {
    await WidgetDataModule.openExactAlarmSettings();
  } catch { /* ignore */ }
}

function toRemainMinutes(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function pushDashboardToWidget(params: {
  battery?: number | null;
  /** 电压法 SOC%（主口径，小组件优先于 vendor battery 显示） */
  socVoltage?: number | null;
  socSource?: 'bms' | 'voltage' | 'vendor' | 'unavailable' | null;
  voltage?: number | null;
  temperature?: number | null;
  range?: number | null;
  charging?: boolean;
  vehicleName?: string;
  healthScore?: number | null;
  locked?: number | null;
  remainChargeTime?: number | string | null;
  /** 自学习续航（优先于 vendor range 显示）与循环次数。 */
  calibratedRange?: number | null;
  cycles?: number | null;
  /** Widget self-refresh credentials — forwarded to the provider so it can
   *  fetch /api/widget/summary by itself while the app process is dead. */
  serverUrl?: string;
  apiKey?: string | null;
}) {
  if (Platform.OS !== 'android' || !WidgetDataModule?.saveWidgetData) return;

  const data: Record<string, string | number | boolean> = {};

  if (!isDemoModeSync() && typeof params.serverUrl === 'string' && params.serverUrl.length > 0) {
    data.widget_server_url = params.serverUrl;
  }
  if (!isDemoModeSync() && typeof params.apiKey === 'string' && params.apiKey.length > 0) {
    data.widget_api_key = params.apiKey;
  }
  const demoMode = isDemoModeSync();

  if (typeof params.battery === 'number' && Number.isFinite(params.battery)) {
    data.widget_battery_pct = params.battery;
  }
  if (typeof params.socVoltage === 'number' && Number.isFinite(params.socVoltage)) {
    data.widget_soc_voltage = params.socVoltage;
  }
  if (params.socSource === 'bms' || params.socSource === 'voltage' || params.socSource === 'vendor' || params.socSource === 'unavailable') {
    data.widget_soc_source = params.socSource;
  }
  if (typeof params.voltage === 'number' && Number.isFinite(params.voltage)) {
    data.widget_voltage = params.voltage;
  }
  if (typeof params.temperature === 'number' && Number.isFinite(params.temperature)) {
    data.widget_temperature = params.temperature;
  }
  if (typeof params.range === 'number' && Number.isFinite(params.range)) {
    data.widget_range = params.range;
  }
  if (typeof params.charging === 'boolean') {
    data.widget_charging = params.charging;
  }
  if (typeof params.vehicleName === 'string' && params.vehicleName.length > 0) {
    data.widget_vehicle_name = params.vehicleName;
  }
  if (typeof params.healthScore === 'number' && Number.isFinite(params.healthScore)) {
    data.widget_health_score = params.healthScore;
  }
  if (typeof params.locked === 'number' && Number.isFinite(params.locked)) {
    data.widget_locked = params.locked;
  }
  const remain = toRemainMinutes(params.remainChargeTime);
  if (remain != null) {
    data.widget_remain_charge = remain;
  }
  if (typeof params.calibratedRange === 'number' && Number.isFinite(params.calibratedRange)) {
    data.widget_range_calibrated = params.calibratedRange;
  }
  if (typeof params.cycles === 'number' && Number.isFinite(params.cycles)) {
    data.widget_cycles = params.cycles;
  }

  if (Object.keys(data).length > 0) {
    if (demoMode) void saveDemoWidgetData(data);
    else {
      data.demo_mode_enabled = false;
      data.widget_demo_mode = false;
      void saveWidgetData(data as Partial<WidgetData>);
    }
  }
}
