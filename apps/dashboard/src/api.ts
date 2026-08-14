/**
 * API client — mirrors the web frontend's api.ts.
 * The server URL is intentionally deployment-specific: configure it in the
 * app settings or with EXPO_PUBLIC_SERVER_URL for a self-hosted install.
 */

import * as SecureStore from 'expo-secure-store';
import { wgs84ToGcj02 } from './coordTransform';
import { blockNinebotAutoLogin, getNinebotAutoLoginCredential } from './ninebotCredentials';
import { initializeDemoMode, isDemoModeReady, isDemoModeSync } from './demo/demoStore';
import {
  getDemoAccount, getDemoAlarms, getDemoBatteryOverview, getDemoCameraDevices, getDemoCommands, getDemoRides,
  getDemoRelay, getDemoRelayConfig, getDemoRideTrail, getDemoSettings, getDemoSnapshot, getDemoTpms, getDemoVehicles,
  getDemoWeather, DEMO_SN,
} from './demo/demoData';
import type {
  Account, AuthStatus, BatteryOverview, RelayCommand, RelayConfigData, RelayConfigInput, RelayStatus, Ride, RidesResponse,
  SettingsPayload, Snapshot, TrailSpeedAnalysis, Vehicle,
} from './types';

export type { AuthStatus };

const BASE_KEY = 'apiBaseUrl';
const ENV_BASE = (process.env.EXPO_PUBLIC_SERVER_URL ?? '').trim().replace(/\/+$/, '');
let baseUrlPromise: Promise<string> | null = null;

export async function getBaseUrl(): Promise<string> {
  // Every dashboard refresh fans out into several requests. Reading
  // SecureStore for each one serializes avoidable native I/O before fetch.
  baseUrlPromise ??= SecureStore.getItemAsync(BASE_KEY).then((stored) => (stored || ENV_BASE).trim().replace(/\/+$/, ''));
  return baseUrlPromise;
}

/** Return only the user-saved address (unset → null) for login/settings UI. */
export async function getStoredBaseUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(BASE_KEY);
}

/**
 * Normalize + validate a user-entered server URL. Throws on garbage —
 * saving an invalid URL used to brick every API call with no way to
 * recover short of guessing the right edit on the settings page.
 * Accepts http(s)://host[:port][/path]; strips ALL trailing slashes.
 */
export function normalizeBaseUrl(input: string): string {
  const u = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?(\/\S*)?$/i.test(u)) {
    throw new Error('服务器地址格式不正确，应以 http:// 或 https:// 开头，例如 https://example.com');
  }
  const parsed = new URL(u);
  if (parsed.protocol === 'http:' && !isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error('公网服务器必须使用 https://；http:// 仅允许局域网或本机地址');
  }
  return u;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 169 && parts[1] === 254);
}

export async function setBaseUrl(url: string): Promise<void> {
  const normalized = normalizeBaseUrl(url);
  await SecureStore.setItemAsync(BASE_KEY, normalized);
  baseUrlPromise = Promise.resolve(normalized);
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const REQUEST_TIMEOUT = 8_000;

/**
 * M10: single funnel for "dashboard session expired". The backend gate
 * answers 401 with code 'unauthenticated' on EVERY gated endpoint once the
 * session dies — pages used to surface a bare "HTTP 401" instead of sending
 * the user back to login. AuthProvider registers the handler below and
 * flips `unlocked` → RootNav redirects to /login by itself.
 *
 * NOTE: 401 with other codes (e.g. 'ninebot_session_missing' from
 * /api/ninebot/whoami) is a NINEBOT-account problem, not a dashboard one,
 * and must NOT trigger this.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

let refreshPromise: Promise<boolean> | null = null;

/** Single-flight silent refresh. Returns true if a new session was established. */
async function attemptRefresh(): Promise<boolean> {
  const token = await getStoredRefreshToken();
  if (!token) return false;
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const auth = await refreshLogin(token);
        await setRefreshToken(auth.refresh_token);
        return true;
      } catch {
        await clearRefreshToken();
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

async function request<T>(
  path: string,
  options?: RequestInit & { timeoutMs?: number },
  retried = false,
): Promise<T> {
  const base = await getBaseUrl();
  if (!base) {
    throw new Error('未配置服务器地址，请在设置中填写自托管服务地址');
  }
  const { timeoutMs, ...fetchOptions } = options ?? {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? REQUEST_TIMEOUT);
  try {
    const res = await fetch(`${base}${path}`, {
      signal: ctrl.signal,
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...fetchOptions,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok === false) {
      const err = body?.errors?.[0];
      if (res.status === 401 && err?.code === 'unauthenticated') {
        // M10: session died. Try to silently re-establish it once via the
        // refresh token, then retry the original request. If that fails (no
        // token / invalid), bounce to the login screen.
        if (!retried) {
          const refreshed = await attemptRefresh();
          if (refreshed) {
            clearTimeout(timer);
            return request<T>(path, options, true);
          }
        }
        try { onUnauthorized?.(); } catch { /* handler must never break requests */ }
      }
      throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`);
    }
    return body as T;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`连接服务器超时（${await getBaseUrl()}），请确认服务器是否已启动`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── Auth ──

const REFRESH_TOKEN_KEY = 'dashRefreshToken';

export async function getStoredRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function setRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  if (!isDemoModeReady()) await initializeDemoMode();
  if (isDemoModeSync()) return { unlocked: true, has_password: true };
  return (await request<{ auth: AuthStatus }>('/api/auth/status')).auth;
}

export async function loginWithPassword(password: string): Promise<AuthStatus & { refresh_token?: string }> {
  if (isDemoModeSync()) return { unlocked: true, has_password: true };
  return (await request<{ auth: AuthStatus & { refresh_token?: string } }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ password }),
  })).auth;
}

export async function logout(refreshToken?: string | null): Promise<void> {
  if (isDemoModeSync()) return;
  await request('/api/auth/logout', {
    method: 'POST',
    body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
  });
}

export async function refreshLogin(refreshToken: string): Promise<{ unlocked: boolean; refresh_token: string }> {
  if (isDemoModeSync()) return { unlocked: true, refresh_token: refreshToken };
  return (await request<{ auth: { unlocked: boolean; refresh_token: string } }>('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  })).auth;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  if (isDemoModeSync()) return;
  await request('/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

// ── Ninebot account ──

export async function whoami(): Promise<Account | null> {
  if (isDemoModeSync()) return getDemoAccount();
  try {
    return (await request<{ account: Account }>('/api/ninebot/whoami')).account;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'ninebot_reauth_required') {
      const restored = await attemptNinebotAutoLogin();
      if (restored) {
        return (await request<{ account: Account }>('/api/ninebot/whoami')).account;
      }
      return null;
    }
    if (e instanceof ApiError && (e.status === 401 || e.code === 'ninebot_session_missing')) {
      return null;
    }
    throw e;
  }
}

let ninebotAutoLoginPromise: Promise<boolean> | null = null;

/** One automatic attempt globally. Failure is persisted as blocked so an
 * app restart cannot create an account-locking retry loop. */
async function attemptNinebotAutoLogin(): Promise<boolean> {
  if (!ninebotAutoLoginPromise) {
    ninebotAutoLoginPromise = (async () => {
      const credential = await getNinebotAutoLoginCredential();
      if (!credential) return false;
      try {
        await loginNinebot(credential.account, credential.password);
        return true;
      } catch {
        await blockNinebotAutoLogin();
        return false;
      } finally {
        ninebotAutoLoginPromise = null;
      }
    })();
  }
  return ninebotAutoLoginPromise;
}

export async function loginNinebot(account: string, password: string): Promise<void> {
  if (isDemoModeSync()) return;
  await request('/api/ninebot/login', {
    method: 'POST',
    body: JSON.stringify({ account, password }),
    timeoutMs: 30_000,
  });
}

/** SMS login: omit code to send verification SMS; pass code to complete login. */
export async function loginNinebotCode(account: string, code?: string): Promise<void> {
  if (isDemoModeSync()) return;
  await request('/api/ninebot/login-code', {
    method: 'POST',
    body: JSON.stringify({ account, code: code || null }),
    timeoutMs: 30_000,
  });
}

// ── Vehicles ──

// M11: endpoints that fan out to the ninebot cloud or aggregate multiple
// tables get longer budgets than the flat 8s default — over the public
// Self-hosted servers may be reached over a LAN or HTTPS reverse proxy; the
// timeout is intentionally longer for fan-out endpoints.
export async function fetchVehicles(): Promise<Vehicle[]> {
  if (isDemoModeSync()) return getDemoVehicles();
  return (await request<{ vehicles: Vehicle[] }>('/api/dashboard/vehicles', { timeoutMs: 20_000 })).vehicles;
}

export async function fetchSnapshot(sn: string): Promise<Snapshot> {
  if (isDemoModeSync()) return getDemoSnapshot();
  return (await request<{ snapshot: Snapshot }>(`/api/dashboard/vehicles/${sn}/snapshot`, { timeoutMs: 15_000 })).snapshot;
}

/** BMS relay phone status (battery / temp / connection) for the dashboard card. */
export async function fetchRelayStatus(
  sn: string,
  opts?: { gpsActive?: boolean; riding?: boolean },
): Promise<RelayStatus> {
  if (isDemoModeSync()) return getDemoRelay();
  const params = new URLSearchParams({ sn });
  if (opts?.gpsActive !== undefined) params.set('gps_active', opts.gpsActive ? '1' : '0');
  if (opts?.riding !== undefined) params.set('riding', opts.riding ? '1' : '0');
  return (await request<{ relay: RelayStatus }>(
    `/api/dashboard/bms-relay/status?${params.toString()}`,
    { timeoutMs: 15_000 },
  )).relay;
}

// ── 中继远控（拍照）──
// 指令是异步的：这里只把它写进 relay_commands，中继下次轮询（≤15s）才取走执行，
// 拍完上传后 status 变 done、result.photo_url 出现。UI 必须轮询 fetchRelayCommands。

/** 下发一条远控指令，返回刚创建的命令行（status=pending）。 */
export async function issueRelayCommand(
  sn: string,
  command: string,
  payload?: Record<string, unknown>,
): Promise<RelayCommand> {
  if (isDemoModeSync()) return getDemoCommands(sn)[0];
  return (await request<{ command: RelayCommand }>('/api/dashboard/bms-relay/command', {
    method: 'POST',
    body: JSON.stringify({ device_sn: sn, command, payload: payload ?? null }),
    timeoutMs: 15_000,
  })).command;
}

/**
 * 把服务端返回的绝对 URL 重写到"当前实际使用的服务器地址"。
 *
 * 服务端拼照片 URL 用的是 config('app.url')，那是一个固定值；而 APP 可能走
 * 局域网 HTTP 或公网 HTTPS。两者不一致时直接用服务端 URL 会加载失败，
 * 因此只取 path 拼当前 base。
 */
export function rewriteToBase(url: string, base: string): string {
  if (!url) return url;
  if (url.startsWith('/')) return `${base}${url}`;
  const m = url.match(/^https?:\/\/[^/]+(\/.*)$/);
  return m ? `${base}${m[1]}` : url;
}

/** 最近 20 条指令历史（倒序）。 */
export async function fetchRelayCommands(sn: string): Promise<RelayCommand[]> {
  if (isDemoModeSync()) return getDemoCommands(sn);
  return (await request<{ commands: { commands: RelayCommand[] } }>(
    `/api/dashboard/bms-relay/commands?device_sn=${encodeURIComponent(sn)}`,
    { timeoutMs: 15_000 },
  )).commands.commands;
}

// ── 中继配置（采样频率 / 低功耗 / 温湿度 MAC）──
// 中继离线优先：这里只把配置写入后端，等中继下次配置轮询才真正生效。

/** 读取某设备的中继配置（后端回落到默认值）。 */
export async function getRelayConfig(sn: string): Promise<RelayConfigData> {
  if (isDemoModeSync()) return getDemoRelayConfig(sn);
  return (await request<{ config: RelayConfigData }>(
    `/api/dashboard/relay/config?device_sn=${encodeURIComponent(sn)}`,
    { timeoutMs: 15_000 },
  )).config;
}

/** 保存某设备的中继配置。字段会做范围/格式校验，返回生效后的完整配置。 */
export async function setRelayConfig(sn: string, cfg: RelayConfigInput): Promise<RelayConfigData> {
  if (isDemoModeSync()) return getDemoRelayConfig(sn);
  return (await request<{ config: RelayConfigData }>('/api/dashboard/relay/config', {
    method: 'POST',
    body: JSON.stringify({ device_sn: sn, ...cfg }),
    timeoutMs: 15_000,
  })).config;
}

// ── Rides ──

export async function fetchRides(sn: string, month?: string): Promise<RidesResponse> {
  if (isDemoModeSync()) return getDemoRides(month);
  const qs = month ? `?month=${month}` : '';
  // First hit of a month triggers a backend upstream sync — slow.
  return await request<RidesResponse>(`/api/dashboard/vehicles/${sn}/rides${qs}`, { timeoutMs: 20_000 });
}

// ── Battery ──

export async function fetchBatteryOverview(sn: string, hours = 24): Promise<BatteryOverview> {
  if (isDemoModeSync()) return getDemoBatteryOverview(sn, hours);
  return (await request<{ overview: BatteryOverview }>(
    `/api/dashboard/battery-overview?sn=${sn}&hours=${hours}`,
    { timeoutMs: 15_000 },
  )).overview;
}

// ── TPMS（胎压/胎温，服务端解码 JH.TPMS 广播帧）──

export interface TpmsWheel {
  position: 'front' | 'rear';
  pressure: number | null;
  temp_c: number | null;
  temp_candidate: boolean;
  checksum_ok: boolean | null;
  token: string | null;
  rssi: number | null;
  updated_at: string | null;
  age_seconds: number | null;
  capture_id: number | null;
  status: string;
}

export interface TpmsCurrent {
  ok: boolean;
  generated_at: string;
  front: TpmsWheel;
  rear: TpmsWheel;
  temp_available: boolean;
  temp_note: string;
  note: string;
}

/**
 * 拉取前后轮胎压/胎温结构化读数（GET /api/tpms/current，session 鉴权）。
 * 解码在服务端完成（JH.TPMS 广播帧）；前后轮使用各自标定参数，
 * 并只采用通过完整性校验的广播帧。
 */
export async function fetchTpms(): Promise<TpmsCurrent> {
  if (isDemoModeSync()) return getDemoTpms();
  return (await request<{ ok: boolean; generated_at: string; front: TpmsWheel; rear: TpmsWheel; temp_available: boolean; temp_note: string; note: string }>(
    '/api/tpms/current',
    { timeoutMs: 15_000 },
  )) as unknown as TpmsCurrent;
}

// ── Ride trail ──

export async function fetchRideTrail(sn: string, rideId: string): Promise<TrailSpeedAnalysis> {
  if (isDemoModeSync()) return getDemoRideTrail(rideId);
  return (await request<{ trail: TrailSpeedAnalysis }>(
    `/api/dashboard/vehicles/${sn}/rides/${rideId}/trail`,
    { timeoutMs: 20_000 },
  )).trail;
}

// ── Relay measured rides (offline tail-box phone, ∫V·I energy) ──


// ── Settings ──

export async function fetchSettings(sn?: string): Promise<SettingsPayload> {
  if (isDemoModeSync()) return getDemoSettings(sn ?? DEMO_SN);
  const qs = sn ? `?sn=${sn}` : '';
  return (await request<{ settings: SettingsPayload }>(`/api/dashboard/settings${qs}`)).settings;
}

export async function updateSettings(payload: {
  device_sn: string;
  priors?: Record<string, number | null>;
  thresholds?: Record<string, number>;
  cycle_count_baseline?: number;
  odometer_baseline_km?: number;
}): Promise<SettingsPayload> {
  if (isDemoModeSync()) return getDemoSettings(payload.device_sn);
  return (await request<{ settings: SettingsPayload }>('/api/dashboard/settings', {
    method: 'PUT', body: JSON.stringify(payload),
  })).settings;
}

// ── Vehicle commands ──

export async function sendCommand(sn: string, action: string): Promise<void> {
  if (isDemoModeSync()) return;
  await request(`/api/dashboard/vehicles/${sn}/command/${action}`, {
    method: 'POST', body: JSON.stringify({ confirmed: true }),
  });
}

// ── BMS live snapshot POST (fire-and-forget) ──

export async function postBmsSnapshot(deviceSn: string, payload: Record<string, unknown>): Promise<void> {
  if (isDemoModeSync()) return;
  try {
    const base = await getBaseUrl();
    await fetch(`${base}/api/bms-live-snapshot`, {
      method: 'POST', credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_sn: deviceSn, ...payload }),
    });
  } catch { /* non-fatal */ }
}

// ── EZVIZ ──

/**
 * Returns null when the backend has no EZVIZ credentials configured (503)
 * so the UI can distinguish "未配置" from "configured but camera offline" —
 * both used to render as a misleading "离线".
 */
export async function fetchEzvizDevices(): Promise<any[] | null> {
  if (isDemoModeSync()) return getDemoCameraDevices();
  try {
    const res = await request<{ devices: { list: any[] } }>('/api/ezviz/devices');
    return res.devices?.list ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 503) return null;
    throw e;
  }
}

/** null = backend not configured (503), same contract as fetchEzvizDevices. */
export async function fetchEzvizAlarms(deviceSerial: string, limit = 20): Promise<AlarmItem[] | null> {
  if (isDemoModeSync()) return getDemoAlarms().slice(0, limit);
  try {
    const res = await request<{ alarms: { list: AlarmItem[]; total: number } }>(`/api/ezviz/alarms/${deviceSerial}?limit=${limit}`);
    return res.alarms?.list ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 503) return null;
    throw e;
  }
}

export async function captureSnapshot(deviceSerial: string): Promise<string> {
  if (isDemoModeSync()) return '';
  const res = await request<{ snapshot_url: { url: string } }>(`/api/ezviz/snapshot-url/${deviceSerial}`);
  return res.snapshot_url?.url ?? '';
}

export interface AlarmItem {
  id: string | null;
  time: string | null;
  type: string | null;
  picUrl: string;
  title: string | null;
  description: string | null;
  deviceSerial: string;
}

// ── 高德天气（移动端直连，复用后端 AMAP_KEY）──
// 后端 /config/map 已把 AMAP_KEY 下发给 App，这里直接用它调高德 REST，
// 无需改动后端、无需额外部署。天气结果按 adcode 缓存 30 分钟，避免反复打高德。

export interface AmapWeatherCast {
  date: string;
  dayWeather: string;
  nightWeather: string;
  dayTemp: number;
  nightTemp: number;
}

export interface AmapWeather {
  city: string;
  adcode: string;
  reportTime: string;
  /** casts[0] = 今日。 */
  today: { dayWeather: string; nightWeather: string; dayTemp: number; nightTemp: number };
  casts: AmapWeatherCast[];
}

/** 取后端下发的 AMAP_KEY（缓存，避免每次天气都请求一次）。 */
let _amapKey: string | null = null;
let _weatherCache: { adcode: string; at: number; data: AmapWeather | null } | null = null;
// 坐标分桶缓存：车基本停一处，位置变化 < ~1km 内复用 adcode，避免每次天气轮询都打 regeo
let _adcodeCache: { lat: number; lng: number; adcode: string; at: number } | null = null;

export async function getAmapKey(): Promise<string> {
  if (isDemoModeSync()) return '';
  if (_amapKey !== null) return _amapKey;
  try {
    const r = await request<{ config: { amap_key: string } }>('/config/map');
    _amapKey = r.config?.amap_key ?? '';
  } catch {
    _amapKey = '';
  }
  return _amapKey;
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return await res.json().catch(() => null);
  } finally {
    clearTimeout(t);
  }
}

const toNum = (v: any): number => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 按车辆当前坐标查高德天气。两步：regeo 拿 adcode → weatherInfo(extensions=all)。
 * 失败（无网络 / 无 Key / 无坐标）一律返回 null，由调用方降级为「无天气」。
 */
export async function fetchWeather(lat: number, lng: number): Promise<AmapWeather | null> {
  if (isDemoModeSync()) return getDemoWeather();
  const key = await getAmapKey();
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);

  // ① 坐标分桶：位置变化 < ~1km（0.01°）且在 24h 内，直接复用上次 regeo 的 adcode，
  //    不再每次轮询都打 regeo（省一次网络往返 + 高德配额）。车停家里/公司位置几乎不变。
  let adcode = '';
  if (
    _adcodeCache &&
    Date.now() - _adcodeCache.at < 24 * 3600 * 1000 &&
    Math.abs(_adcodeCache.lat - lat) < 0.01 &&
    Math.abs(_adcodeCache.lng - lng) < 0.01
  ) {
    adcode = _adcodeCache.adcode;
  } else {
    try {
      const rg: any = await fetchJson(
        `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(key)}&location=${gcjLng},${gcjLat}&extensions=base`,
      );
      adcode = rg?.regeocode?.addressComponent?.adcode ?? '';
      if (adcode) _adcodeCache = { lat, lng, adcode, at: Date.now() };
    } catch {
      /* ignore */
    }
  }
  if (!adcode) return null;

  if (_weatherCache && _weatherCache.adcode === adcode && Date.now() - _weatherCache.at < 30 * 60 * 1000) {
    return _weatherCache.data;
  }

  let data: AmapWeather | null = null;
  try {
    const w: any = await fetchJson(
      `https://restapi.amap.com/v3/weather/weatherInfo?key=${encodeURIComponent(key)}&city=${adcode}&extensions=all`,
    );
    const f = w?.forecasts?.[0];
    if (f && Array.isArray(f.casts) && f.casts.length) {
      data = {
        city: f.city ?? '',
        adcode: f.adcode ?? adcode,
        reportTime: f.reporttime ?? '',
        today: {
          dayWeather: f.casts[0].dayweather ?? '',
          nightWeather: f.casts[0].nightweather ?? '',
          dayTemp: toNum(f.casts[0].daytemp),
          nightTemp: toNum(f.casts[0].nighttemp),
        },
        casts: f.casts.map((c: any) => ({
          date: c.date ?? '',
          dayWeather: c.dayweather ?? '',
          nightWeather: c.nightweather ?? '',
          dayTemp: toNum(c.daytemp),
          nightTemp: toNum(c.nighttemp),
        })),
      };
    }
  } catch {
    /* ignore */
  }

  // ② 只在成功拿到数据时写缓存；失败不刷新缓存、下次轮询再试，
  //    避免一次网络抖动把天气缓存成 null 整整 30 分钟不显示。
  if (data) {
    _weatherCache = { adcode, at: Date.now(), data };
  }
  return data;
}

// ── 仪表盘自更新 ──
// 设置页「应用更新」用：拉发布包元信息 + 短时下载 token，再用 appUpdate.ts 下载安装。

export interface DashboardApkInfo {
  exists: boolean;
  size?: number | null;
  version?: string | null;
  build?: number | null;
  published_at?: string | null;
  sha256?: string | null;
  release_notes?: string | null;
  /** 短时有效（10 分钟）、可重试的一次性下载凭证，传给二进制端点 ?t=。 */
  download_token?: string | null;
}

/** 登录用户拉取服务器上的最新安装包信息 + 下载 token（session 鉴权）。 */
export async function fetchDashboardApkInfo(): Promise<DashboardApkInfo> {
  if (isDemoModeSync()) return { exists: false, version: null, build: null, release_notes: '演示模式不检查服务器更新' };
  return (await request<{ dashboard_apk: DashboardApkInfo }>('/api/dashboard/apk/info')).dashboard_apk;
}
