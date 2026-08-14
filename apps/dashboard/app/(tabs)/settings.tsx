import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Animated, BackHandler, Easing, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { AppText } from '../../src/components/AppText';
import { Ionicons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Application from 'expo-application';
import { useAuth } from '../../src/auth';
import {
  changePassword, fetchDashboardApkInfo, fetchSettings, getBaseUrl,
  getRelayConfig, issueRelayCommand, loginNinebot, loginNinebotCode, setBaseUrl,
  setRelayConfig, updateSettings, whoami,
  type DashboardApkInfo,
} from '../../src/api';
import { downloadAndInstallDashboardApk } from '../../src/appUpdate';
import { EmptyState } from '../../src/components/EmptyState';
import { Card } from '../../src/components/Card';
import { SectionHeader } from '../../src/components/SectionHeader';
import {
  canScheduleExactAlarm, getGpsSpeedEnabled, getHomeRefreshSec, getLowBatteryPct, getMapZoom, getNotificationHealth, getNotificationPrefs,
  getTempDangerC, getTempWarnC, getTipPrefs, getWidgetRefreshInterval, hasNotificationPermission,
  openExactAlarmSettings, openNotificationSettings, pushDashboardToWidget, refreshNotificationsNow,
  requestNotificationPermission, sendTestNotification, setGpsSpeedEnabled, setHomeRefreshSec, setLowBatteryPct,
  setMapZoom, setNotificationPref, setTempDangerC, setTempWarnC, setTipPref, setWidgetRefreshInterval,
  type NotificationPrefs, type TipPrefs,
} from '../../src/widgetData';
import { useHeaderTheme } from '../../src/hooks/useHeaderTheme';
import { BackButton } from '../../src/components/BackButton';
import { useStagger, enterStyle, useReveal, revealStyle, spinStyle, usePressScale } from '../../src/hooks/useStagger';
import { InfoRow } from '../../src/components/InfoRow';
import { InfoHint } from '../../src/components/InfoHint';
import { type HintKey } from '../../src/valueHints';
import { useResponsive } from '../../src/hooks/useResponsive';
import { colors, fontMono, fontSize, headerThemes, radius, shadow, spacing, tint, type BadgeTone } from '../../src/theme';
import type { Account, RelayConfigData, RelayStatus, SettingsPayload, Vehicle } from '../../src/types';
import { useVehicleData } from '../../src/vehicleData';
import { useAppTheme } from '../../src/ThemeProvider';
import { useDemoMode } from '../../src/demo/DemoModeProvider';
import type { ThemeColors, WidgetThemeBehavior } from '../../src/themePacks';
import {
  getNinebotAutoLoginStatus, saveNinebotAutoLoginCredential, setNinebotAutoLoginEnabled,
  type NinebotAutoLoginStatus,
} from '../../src/ninebotCredentials';

const PRIOR_LABELS: Record<string, string> = {
  bms_full_charge_voltage: '满充截止电压 (V)',
  bms_cutoff_voltage: '欠压保护 (V)',
  charger_output_current_a: '充电器输出电流 (A)',
  nominal_voltage: '标称电压 (V)',
  nominal_capacity_ah: '标称容量 (Ah)',
  capacity_tolerance_pct: '容量偏差容忍 (%)',
};

const THRESHOLD_LABELS: Record<string, string> = {
  temp_bucket_cold_max_c: '低温上限 (°C)',
  temp_bucket_warm_max_c: '常温上限 (°C)',
  plateau_voltage_delta: '电压平台窗 (V)',
  plateau_min_minutes: '平台持续 (min)',
  capacity_ema_alpha_base: '容量 EMA 基础 α',
};

const RIDE_INTERVALS_MS = [1000, 2000, 3000, 5000];
const IDLE_INTERVALS_SEC = [30, 60, 120, 300, 600];
const RELAY_POLL_INTERVALS_SEC = [15, 30, 60];
const MONITOR_INTERVALS_SEC = [0, 30, 60, 120, 180, 300, 600];

/** 与上面两套 label 一一对应，给每个数值配一个说明键。 */
const PRIOR_HINTS: Record<string, HintKey> = {
  bms_full_charge_voltage: 'prior_full_charge_volt',
  bms_cutoff_voltage: 'prior_cutoff_volt',
  charger_output_current_a: 'prior_charger_current',
  nominal_voltage: 'prior_nominal_volt',
  nominal_capacity_ah: 'prior_nominal_cap_ah',
  capacity_tolerance_pct: 'prior_cap_tolerance',
};
const THRESHOLD_HINTS: Record<string, HintKey> = {
  temp_bucket_cold_max_c: 'thr_temp_cold',
  temp_bucket_warm_max_c: 'thr_temp_warm',
  plateau_voltage_delta: 'thr_plateau_delta',
  plateau_min_minutes: 'thr_plateau_min',
  capacity_ema_alpha_base: 'thr_ema_alpha',
};

/** HH:MM for the "已保存" badge — a bare badge that never changes is easy
 *  to mistake for stale UI; the timestamp proves the save just happened. */
function fmtHm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "最后上报" 的相对时间：null → 破折号；0~59s → 刚刚；其余按秒/分/时/天。 */
function fmtAgo(ageSeconds: number | null): string {
  if (ageSeconds == null) return '—';
  if (ageSeconds < 60) return '刚刚';
  const m = Math.floor(ageSeconds / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export default function SettingsScreen({ nested = false, initialPane = null }: { nested?: boolean; initialPane?: string | null } = {}) {
  const { logout } = useAuth();
  const { top } = useHeaderTheme(headerThemes.settings);
  const router = useRouter();
  const rs = useResponsive();
  const { colors: themeColors, mode, resolvedMode, themePack, widgetThemeBehavior, setWidgetThemeBehavior } = useAppTheme();
  const { isDemoMode } = useDemoMode();
  const { vehicles, selectedSn, snapshot, relay: relayStatus, refreshRelay } = useVehicleData();
  const vehicle = vehicles.find((v) => v.sn === selectedSn) ?? vehicles[0] ?? null;

  const [serverUrl, setServerUrl] = useState('');

  const [data, setData] = useState<SettingsPayload | null>(null);
  const [priorsEdit, setPriorsEdit] = useState<Record<string, string>>({});
  const [thresholdsEdit, setThresholdsEdit] = useState<Record<string, string>>({});
  const [odometerEdit, setOdometerEdit] = useState('');

  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  const [loading, setLoading] = useState(true);
  const [savingPriors, setSavingPriors] = useState(false);
  const [savingThresholds, setSavingThresholds] = useState(false);
  const [savingOdometer, setSavingOdometer] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [serverSaved, setServerSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const bannerAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (savedAt) {
      bannerAnim.setValue(0);
      Animated.timing(bannerAnim, { toValue: 1, duration: 360, useNativeDriver: true, easing: Easing.out(Easing.ease) }).start();
    }
  }, [savedAt]);

  const [nbAccount, setNbAccount] = useState<Account | null>(null);
  const [nbUser, setNbUser] = useState('');
  const [nbPassword, setNbPassword] = useState('');
  const [nbCode, setNbCode] = useState('');
  const [nbMode, setNbMode] = useState<'password' | 'sms'>('password');
  const [nbCodeSent, setNbCodeSent] = useState(false);
  const [nbBusy, setNbBusy] = useState(false);
  const [nbMsg, setNbMsg] = useState<string | null>(null);
  const [nbErr, setNbErr] = useState<string | null>(null);
  const [nbAutoLogin, setNbAutoLogin] = useState<NinebotAutoLoginStatus>({ enabled: false, ready: false, blocked: false, account: null });

  const [widgetMin, setWidgetMin] = useState(30);
  const [widgetBehavior, setWidgetBehaviorState] = useState<WidgetThemeBehavior>(widgetThemeBehavior);
  // 精确闹钟权限：Android 12+ 需要它，小组件后台才能准时自刷新（否则被 Doze 批量延迟）。
  const [exactAlarmOk, setExactAlarmOk] = useState(true);

  // 通知开关（原生 widget 刷新链路读取同一 prefs）+ 折叠分组状态
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs>({ chargeStart: true, chargeEnd: true, tempHigh: true, ezvizAlarm: true, lowBattery: true });
  const [notifPerm, setNotifPerm] = useState(true);
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifMsg, setNotifMsg] = useState<string | null>(null);
  const [notifErr, setNotifErr] = useState<string | null>(null);
  const [notifHealth, setNotifHealth] = useState<{ lastSuccessAt: number | null; nextCheckAt: number | null; lastError: string | null }>({ lastSuccessAt: null, nextCheckAt: null, lastError: null });
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({}); // 默认全部折叠
  const [settingsCategory, setSettingsCategory] = useState<'general' | 'device' | 'battery' | 'system'>('general');
  const [settingsPane, setSettingsPane] = useState<string | null>(initialPane);

  // In the nested More stack, a pane opened from the Settings index is a
  // local detail state and should collapse back to that index.  A pane that
  // was supplied as the route's initialPane (Widget settings, for example)
  // is itself a stack screen and should pop to its parent route.
  const closeSettingsPane = useCallback(() => {
    if (nested && initialPane && settingsPane === initialPane) router.back();
    else setSettingsPane(null);
  }, [initialPane, nested, router, settingsPane]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (settingsPane) { closeSettingsPane(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [closeSettingsPane, settingsPane]);

  // ── 应用更新（自更新：下载到手机 + 系统安装器确认，无 root/静默装）──
  const [curVersion, setCurVersion] = useState<string>('');
  const [curBuild, setCurBuild] = useState<number | null>(null);
  const [apkInfo, setApkInfo] = useState<DashboardApkInfo | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [downloadFraction, setDownloadFraction] = useState(0);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [updateErr, setUpdateErr] = useState<string | null>(null);

  // 首页体验偏好（本地存储，非服务器下发）
  const [homeSec, setHomeSec] = useState(300);
  const [tipPrefs, setTipPrefs] = useState<TipPrefs>({ enabled: true, anomaly: true, smart: true, weather: true });
  const [lowBattPct, setLowBattPct] = useState(10);
  const [tempWarn, setTempWarn] = useState(40);
  const [tempDanger, setTempDanger] = useState(45);
  const [mapZoom, setMapZoom] = useState(15);
  const [gpsSpeedOn, setGpsSpeedOn] = useState(false);
  const sectionAnims = useStagger(8);

  // ── 中继手机配置 ──
  // 采样间隔以"秒/毫秒"为单位在滑块上编辑，保存时换算回毫秒传给后端。
  const [relayCfg, setRelayCfg] = useState<RelayConfigData | null>(null);
  const [idleSec, setIdleSec] = useState(120);          // 停车保存/上传间隔（秒），推荐 120
  const [rideMs, setRideMs] = useState(1000);           // 骑行采样间隔（毫秒），200~60000（推荐 1000）
  const [lowPower, setLowPower] = useState(true);
  const [thermoMac, setThermoMac] = useState('');
  const [pollSec, setPollSec] = useState(60);           // 停车远控轮询（秒），骑行自动 <=15 秒
  const [monitorSec, setMonitorSec] = useState(180);   // 停车后高频监测时长（秒），0~600（推荐 180）

  // 中继频率的「最优推荐值」：骑行 1Hz 保证功率曲线细腻且链路稳健（已加高连接优先级）；
  // 保护板底层始终 <=30s 保活；停车只把保存/上传降为 2min。远控停车 60s，骑行自动 <=15s。
  const RELAY_RECOMMENDED = { idleSec: 120, rideMs: 1000, pollSec: 60, monitorSec: 180 };
  const [relayMsg, setRelayMsg] = useState<string | null>(null);
  const [relayErr, setRelayErr] = useState<string | null>(null);
  const [savingRelayCfg, setSavingRelayCfg] = useState(false);
  const [relayCmdBusy, setRelayCmdBusy] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setServerUrl(await getBaseUrl());
      setWidgetMin(await getWidgetRefreshInterval());
      setNotifPrefs(await getNotificationPrefs());
      setNotifPerm(await hasNotificationPermission());
      setNotifHealth(await getNotificationHealth());
      setExactAlarmOk(await canScheduleExactAlarm());
      setHomeSec(await getHomeRefreshSec());
      setTipPrefs(await getTipPrefs());
      setLowBattPct(await getLowBatteryPct());
      setTempWarn(await getTempWarnC());
      setTempDanger(await getTempDangerC());
      setMapZoom(await getMapZoom());
      setGpsSpeedOn(await getGpsSpeedEnabled());
      setNbAutoLogin(await getNinebotAutoLoginStatus());
      // 当前安装版本（用于与服务器发布包比对）
      setCurVersion(Application.nativeApplicationVersion ?? '');
      const b = Number(Application.nativeBuildVersion ?? '');
      const installedBuild = Number.isFinite(b) ? b : null;
      setCurBuild(installedBuild);
      // State has not committed yet on this first render. Pass the native
      // build explicitly so a just-opened settings page can immediately
      // recognise a newer server package.
      await checkUpdate(installedBuild);
    })();
  }, []);

  // Notification/background refresh credentials must not depend on the user
  // visiting Home first. Settings receives the same shared snapshot and can
  // arm the native chain itself.
  useEffect(() => {
    if (!snapshot?.widget_token) return;
    void getBaseUrl().then((url) => {
      pushDashboardToWidget({ serverUrl: url, apiKey: snapshot.widget_token });
    }).catch(() => {});
  }, [snapshot?.widget_token]);

  // 从系统设置页返回后重检精确闹钟权限（授权在另一个 App 里完成）。
  // 仅当权限「刚刚从不可用变为可用」时，才重新部署刷新间隔，让链路切换到
  // 精确、穿透 Doze 的闹钟。不要用 state 里的 widgetMin 在每次聚焦都重写——
  // 首次聚焦时 widgetMin 还是默认值 30（load 还没把已存值读回来），会覆盖掉
  // 用户设过的间隔，导致「设了 5 分钟、再打开又变回 30」。
  const prevExactAlarmOk = useRef<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const ok = await canScheduleExactAlarm();
        if (!active) return;
        setExactAlarmOk(ok);
        const permission = await hasNotificationPermission();
        if (!active) return;
        setNotifPerm(permission);
        setNotifHealth(await getNotificationHealth());
        if (ok && prevExactAlarmOk.current === false) {
          await setWidgetRefreshInterval(await getWidgetRefreshInterval());
        }
        prevExactAlarmOk.current = ok;
      })();
      return () => { active = false; };
    }, [])
  );

  const toggleSection = useCallback((id: string) => {
    setOpenSections(s => ({ ...s, [id]: !s[id] }));
  }, []);

  const toggleNotif = useCallback(async (key: keyof NotificationPrefs, value: boolean) => {
    setNotifErr(null); setNotifMsg(null);
    setNotifPrefs(p => ({ ...p, [key]: value }));
    const saved = await setNotificationPref(key, value);
    if (!saved) {
      setNotifPrefs(p => ({ ...p, [key]: !value }));
      setNotifErr('通知设置保存失败，请重试');
      return;
    }
    if (value && !(await hasNotificationPermission())) {
      const granted = await requestNotificationPermission();
      setNotifPerm(granted);
      if (!granted) {
        setNotifErr('系统通知权限仍未开启，请点击上方提示进入系统设置');
        return;
      }
    }
    await refreshNotificationsNow();
    setNotifMsg(value ? '已开启；后台每 5 分钟检查，事件发生时通知' : '已关闭该类通知');
  }, []);

  const testNotifications = useCallback(async () => {
    setNotifBusy(true); setNotifErr(null); setNotifMsg(null);
    try {
      let granted = await hasNotificationPermission();
      if (!granted) granted = await requestNotificationPermission();
      setNotifPerm(granted);
      if (!granted) {
        setNotifErr('系统通知权限或“车辆事件”通知渠道未开启');
        return;
      }
      const sent = await sendTestNotification();
      if (sent) setNotifMsg('测试通知已发送，请查看系统通知栏');
      else setNotifErr('测试通知发送失败，请检查系统通知设置');
    } finally {
      setNotifBusy(false);
    }
  }, []);

  const toggleTip = useCallback((key: keyof TipPrefs, value: boolean) => {
    setTipPrefs(p => ({ ...p, [key]: value }));
    void setTipPref(key, value);
  }, []);

  const loadNinebot = useCallback(async () => {
    try {
      setNbAccount(await whoami());
    } catch {
      setNbAccount(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      await loadNinebot();
      const v = vehicle;
      if (!v) { setLoading(false); return; }
      const s = await fetchSettings(v.sn);
      setData(s);
      setPriorsEdit({
        bms_full_charge_voltage: s.priors.bms_full_charge_voltage?.toString() ?? '',
        bms_cutoff_voltage: s.priors.bms_cutoff_voltage?.toString() ?? '',
        max_charge_current_a: s.priors.max_charge_current_a?.toString() ?? '',
        charger_output_current_a: s.priors.charger_output_current_a?.toString() ?? '',
        ant_bms_measured_current_a: s.priors.ant_bms_measured_current_a?.toString() ?? '',
        nominal_voltage: s.priors.nominal_voltage?.toString() ?? '',
        nominal_capacity_ah: s.priors.nominal_capacity_ah?.toString() ?? '',
        capacity_tolerance_pct: s.priors.capacity_tolerance_pct?.toString() ?? '',
      });
      setThresholdsEdit(
        Object.fromEntries(Object.entries(s.thresholds).map(([k, v]) => [k, v.toString()]))
      );
      setOdometerEdit(s.odometer_baseline_km?.toString() ?? '');
    } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setLoading(false); }
  }, [loadNinebot, vehicle?.sn]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // 中继配置 / 实时状态：依赖 vehicle（device_sn = vehicle.sn）。
  const loadRelay = useCallback(async (sn: string) => {
    try {
      const cfg = await getRelayConfig(sn);
      setRelayCfg(cfg);
      setIdleSec(Math.round(cfg.idle_ms / 1000));
      setRideMs(cfg.ride_ms);
      setLowPower(cfg.low_power);
      setThermoMac(cfg.thermo_mac ?? '');
      setPollSec(Math.max(1, Math.round(cfg.poll_ms / 1000)));
      setMonitorSec(cfg.monitor_secs);
    } catch { /* 配置读取失败时保留界面默认值，不阻断其它设置 */ }
    try { await refreshRelay(); } catch { /* 状态不可用时静默 */ }
  }, [refreshRelay]);

  useEffect(() => {
    if (vehicle) void loadRelay(vehicle.sn);
  }, [vehicle, loadRelay]);

  const handleNinebotPasswordLogin = async () => {
    if (!nbUser.trim() || !nbPassword) {
      setNbErr('请输入九号账号和密码');
      return;
    }
    setNbBusy(true); setNbErr(null); setNbMsg(null);
    try {
      const account = nbUser.trim();
      const password = nbPassword;
      await loginNinebot(account, password);
      if (nbAutoLogin.enabled) {
        await saveNinebotAutoLoginCredential(account, password);
        setNbAutoLogin(await getNinebotAutoLoginStatus());
      }
      setNbPassword('');
      setNbMsg(nbAutoLogin.enabled
        ? '登录成功；自动续登凭据已安全保存在本机'
        : '九号账号登录成功，token 已保存到服务器');
      await load();
    } catch (e) {
      setNbErr(e instanceof Error ? e.message : '登录失败');
    } finally {
      setNbBusy(false);
    }
  };

  const [codeCooldown, setCodeCooldown] = useState(0);
  useEffect(() => {
    if (codeCooldown <= 0) return;
    const t = setTimeout(() => setCodeCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [codeCooldown]);

  const handleNinebotSendCode = async () => {
    if (!nbUser.trim()) {
      setNbErr('请输入手机号');
      return;
    }
    if (codeCooldown > 0) return;
    setNbBusy(true); setNbErr(null); setNbMsg(null);
    try {
      await loginNinebotCode(nbUser.trim());
      setNbCodeSent(true);
      setCodeCooldown(60);
      setNbMsg('验证码已发送，请查收短信');
    } catch (e) {
      setNbErr(e instanceof Error ? e.message : '发送验证码失败');
    } finally {
      setNbBusy(false);
    }
  };

  const handleNinebotCodeLogin = async () => {
    if (!nbUser.trim() || !nbCode.trim()) {
      setNbErr('请输入手机号和验证码');
      return;
    }
    setNbBusy(true); setNbErr(null); setNbMsg(null);
    try {
      await loginNinebotCode(nbUser.trim(), nbCode.trim());
      setNbCode('');
      setNbCodeSent(false);
      setNbMsg('九号账号登录成功，token 已保存到服务器');
      await load();
    } catch (e) {
      setNbErr(e instanceof Error ? e.message : '登录失败');
    } finally {
      setNbBusy(false);
    }
  };

  const saveServerConfig = async () => {
    setSavingServer(true);
    try {
      // R7: setBaseUrl validates the URL and throws on garbage — surface
      // the reason instead of bricking every API call silently.
      await setBaseUrl(serverUrl);
      setServerSaved(true);
      setTimeout(() => setServerSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : '服务器地址无效');
    } finally {
      setSavingServer(false);
    }
  };

  const handleChangePassword = async () => {
    if (newPw !== confirmPw) { setPwErr('两次输入不一致'); return; }
    if (newPw.length < 8) { setPwErr('密码至少 8 个字符'); return; }
    setPwSaving(true); setPwErr(null); setPwMsg(null);
    try {
      await changePassword(curPw, newPw);
      setPwMsg('密码已更新');
      setCurPw(''); setNewPw(''); setConfirmPw('');
    } catch (e) { setPwErr(e instanceof Error ? e.message : '修改失败'); }
    finally { setPwSaving(false); }
  };

  // 自更新：拉服务器发布包信息，按 build 号判断是否有新版本。
  const checkUpdate = useCallback(async (installedBuild?: number | null) => {
    setUpdateChecking(true); setUpdateErr(null); setUpdateMsg(null);
    try {
      const info = await fetchDashboardApkInfo();
      setApkInfo(info);
      const localBuild = installedBuild ?? curBuild;
      const newer = info.exists && info.build != null && localBuild != null && info.build > localBuild;
      setHasUpdate(!!newer);
    } catch (e) {
      setApkInfo(null);
      setHasUpdate(false);
      setUpdateErr(e instanceof Error ? e.message : '检查更新失败');
    } finally {
      setUpdateChecking(false);
    }
  }, [curBuild]);

  // 下载到手机并调起系统安装器（前台、用户点确认，无 root/静默装）。
  const doUpdate = useCallback(async () => {
    if (!hasUpdate || !apkInfo?.download_token || !apkInfo.sha256) return;
    setUpdateDownloading(true); setDownloadFraction(0); setUpdateErr(null); setUpdateMsg(null);
    try {
      const base = await getBaseUrl();
      await downloadAndInstallDashboardApk(base, apkInfo.download_token, apkInfo.sha256, apkInfo.size ?? null, (p) => setDownloadFraction(p.fraction));
      setUpdateMsg('已发起安装，请在弹出的系统安装器中点击「安装」');
    } catch (e) {
      setUpdateErr(e instanceof Error ? e.message : '下载或安装失败');
    } finally {
      setUpdateDownloading(false);
    }
  }, [hasUpdate, apkInfo]);

  // 展开「应用更新」分区时自动复查一次。
  useEffect(() => {
    if (openSections.update) void checkUpdate();
  }, [openSections.update, checkUpdate]);

  const parseNumericEdits = (edits: Record<string, string>, labels: Record<string, string>): Record<string, number | null> | null => {
    const out: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(edits)) {
      const trimmed = v.trim();
      if (trimmed === '') { out[k] = null; continue; }
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        setError(`「${labels[k] ?? k}」不是有效数字：${v}`);
        return null;
      }
      out[k] = n;
    }
    return out;
  };

  const savePriors = async () => {
    if (!data) return;
    const priors = parseNumericEdits(priorsEdit, PRIOR_LABELS);
    if (priors === null) return;
    setSavingPriors(true); setError(null);
    try {
      await updateSettings({ device_sn: data.device_sn, priors });
      setSavedAt(new Date().toISOString());
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSavingPriors(false); }
  };

  const saveThresholds = async () => {
    if (!data) return;
    const parsed = parseNumericEdits(thresholdsEdit, THRESHOLD_LABELS);
    if (parsed === null) return;
    const thresholds: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) { if (v !== null) thresholds[k] = v; }
    setSavingThresholds(true); setError(null);
    try {
      await updateSettings({ device_sn: data.device_sn, thresholds });
      setSavedAt(new Date().toISOString());
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSavingThresholds(false); }
  };

  const saveOdometer = async () => {
    if (!data) return;
    const km = odometerEdit.trim() === '' ? NaN : Number(odometerEdit);
    if (!Number.isFinite(km) || km < 0) { setError('请输入有效的表显总里程 (km)'); return; }
    setSavingOdometer(true); setError(null);
    try {
      await updateSettings({ device_sn: data.device_sn, odometer_baseline_km: km });
      setSavedAt(new Date().toISOString());
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSavingOdometer(false); }
  };

  // 保存采样频率 / 低功耗 / 温湿度 MAC 到后端（中继下次轮询才真正生效）。
  const saveRelayConfig = async () => {
    if (!vehicle) return;
    // 温湿度 MAC 做前端格式校验，避免把明显错误的串写进后端（后端也会再校验）。
    const mac = thermoMac.trim();
    if (mac !== '' && !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)) {
      setRelayErr('温湿度计 MAC 格式应为 AA:BB:CC:DD:EE:FF');
      return;
    }
    setSavingRelayCfg(true); setRelayErr(null); setRelayMsg(null);
    try {
      const normalizedMac = mac === '' ? null : mac.toUpperCase();
      const previousMac = relayCfg?.thermo_mac?.toUpperCase() ?? null;
      const payload: Parameters<typeof setRelayConfig>[1] = {
        idle_ms: idleSec * 1000,
        ride_ms: rideMs,
        low_power: lowPower,
        poll_ms: pollSec * 1000,
        monitor_secs: monitorSec,
      };
      // Only send thermo_mac when the user actually edited it. Previously every
      // unrelated sampling save also sent null while this field was still empty,
      // which could silently disable a working temperature/humidity sensor.
      if (normalizedMac !== previousMac) payload.thermo_mac = normalizedMac;
      const cfg = await setRelayConfig(vehicle.sn, payload);
      setRelayCfg(cfg);
      setIdleSec(Math.round(cfg.idle_ms / 1000));
      setRideMs(cfg.ride_ms);
      setLowPower(cfg.low_power);
      setThermoMac(cfg.thermo_mac ?? '');
      setPollSec(Math.max(1, Math.round(cfg.poll_ms / 1000)));
      setMonitorSec(cfg.monitor_secs);
      setRelayMsg(`已保存，中继下一次轮询（通常 ≤${pollSec} 秒）生效`);
      setTimeout(() => setRelayMsg(null), 3000);
    } catch (e) {
      setRelayErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSavingRelayCfg(false);
    }
  };

  // 一键恢复中继频率「推荐值」：仅回填本地状态，需点保存才生效。
  const restoreRecommendedRelay = () => {
    setIdleSec(RELAY_RECOMMENDED.idleSec);
    setRideMs(RELAY_RECOMMENDED.rideMs);
    setPollSec(RELAY_RECOMMENDED.pollSec);
    setMonitorSec(RELAY_RECOMMENDED.monitorSec);
    setLowPower(true);
    setRelayMsg('已恢复推荐值，点「保存中继配置」生效');
    setTimeout(() => setRelayMsg(null), 3000);
  };

  // 下发一条远控指令（拍照/回传/重启/清空）。指令异步：中继轮询取走后执行。
  const sendRelayCommand = async (command: string, payload?: Record<string, unknown>) => {
    if (!vehicle) return;
    if (isDemoMode) {
      Alert.alert('演示模式', '演示模式：不会执行真实设备操作。');
      return;
    }
    setRelayCmdBusy(command); setRelayErr(null); setRelayMsg(null);
    try {
      await issueRelayCommand(vehicle.sn, command, payload);
      const label: Record<string, string> = {
        photo: '已下发拍照指令，中继取走后自动拍摄上传',
        flush: '已下发立即回传指令',
        restart: '已下发重启指令，中继将自动重启',
        'clear-backlog': '已下发清空离线缓存指令',
        update_apk: '已下发固件更新指令，S7 将自动下载并静默安装（约 10–30 秒），完成后自动重启为新版',
      };
      setRelayMsg(label[command] ?? '指令已下发');
      setTimeout(() => setRelayMsg(null), 3000);
      // 几秒后刷新状态，看到指令被取走 / 缓存变化。
      setTimeout(() => { void loadRelay(vehicle.sn); }, 4000);
    } catch (e) {
      setRelayErr(e instanceof Error ? e.message : '指令下发失败');
    } finally {
      setRelayCmdBusy(null);
    }
  };

  const toggleNinebotAutoLogin = async (enabled: boolean) => {
    try {
      await setNinebotAutoLoginEnabled(enabled);
      const status = await getNinebotAutoLoginStatus();
      setNbAutoLogin(enabled && !status.ready ? { ...status, enabled: true } : status);
      if (enabled && !status.ready) {
        setNbMsg('已开启；请在下方用账号密码登录一次以安全保存凭据');
      } else if (!enabled) {
        setNbMsg('已关闭并删除本机保存的九号密码');
      }
      setNbErr(null);
    } catch {
      setNbErr('安全存储不可用，无法修改自动续登设置');
    }
  };

  const confirmClearBacklog = () => Alert.alert(
    '确认清空离线缓存',
    '尚未回传的保护板数据会永久丢失。只有确认这些数据不再需要时才继续。',
    [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => { void sendRelayCommand('clear-backlog', { confirmed: true }); } },
    ],
  );


  if (loading && !data) {
    return (
      <View style={{ flex: 1, backgroundColor: themeColors.background }}>
        <EmptyState
          variant="pulse"
          icon="settings-outline"
          title="加载中…"
          subtitle="正在读取车辆与 BMS 配置"
          accent={colors.primary}
          accentBg={colors.primaryLight}
        />
      </View>
    );
  }

  const ecBadge = data?.wh_per_km_current != null ? `${data.wh_per_km_current.toFixed(1)} Wh/km` : '校准中';

  const enabledNotifCount = Object.values(notifPrefs).filter(Boolean).length;
  const openSettingsPane = (pane: string, category: 'general' | 'device' | 'battery' | 'system', section: string) => {
    setSettingsPane(pane);
    setSettingsCategory(category);
    setOpenSections(current => ({ ...current, [section]: true }));
  };

  return (
    <ScrollView style={[s.container, { backgroundColor: themeColors.background }]} contentContainerStyle={{ paddingHorizontal: rs.pagePad, paddingTop: top, paddingBottom: spacing.xxl }}>
      <View style={s.settingsNavHeader}>
        {settingsPane ? <Pressable onPress={closeSettingsPane} style={[s.settingsBack, { backgroundColor: themeColors.surfaceSecondary }]}><Ionicons name="arrow-back" size={20} color={themeColors.textPrimary} /></Pressable> : <BackButton />}
        <View style={{ flex: 1 }}><AppText style={[s.settingsTitle, { color: themeColors.textPrimary }]}>{settingsPane ?? '设置'}</AppText>{!settingsPane && <AppText style={[s.settingsSubtitle, { color: themeColors.textMuted }]}>偏好、车辆与设备管理</AppText>}</View>
      </View>
      {!settingsPane && <SettingsIndex
        colors={themeColors}
        themeSummary={`${themePack === 'default-tech' ? '默认科技' : 'Anime Theme 01'} · ${mode === 'system' ? '跟随系统' : resolvedMode === 'dark' ? '深色' : '浅色'}`}
        notificationSummary={`${enabledNotifCount} 项开启`}
        vehicleSummary={vehicle?.name ?? '未选车辆'}
        relaySummary={relayStatus?.connected ? '在线' : '离线'}
        onTheme={() => router.push(nested ? '/(tabs)/more/theme-center' : '/theme-center')}
        onDisplay={() => router.push(nested ? '/(tabs)/more/theme-center' : '/theme-center')}
        onWidget={() => nested ? router.push('/(tabs)/more/widget') : openSettingsPane('桌面小组件', 'system', 'widget')}
        onNotifications={() => openSettingsPane('通知设置', 'general', 'notify')}
        onVehicle={() => openSettingsPane('车辆设置', 'device', 'vehicle')}
        onData={() => openSettingsPane('数据设置', 'general', 'home')}
        onRelay={() => openSettingsPane('中继设备', 'system', 'relay')}
        onMonitor={() => router.push(nested ? '/(tabs)/more/monitor' : '/camera')}
        onAccount={() => openSettingsPane('九号账号', 'general', 'connect')}
        onBattery={() => openSettingsPane('电池硬件档案', 'battery', 'calibration')}
        onAdvanced={() => openSettingsPane('高级设置', 'system', 'update')}
        onAbout={() => openSettingsPane('关于本应用', 'system', 'update')}
      />}
      {settingsPane && error && <View style={s.errorCard}><AppText style={s.errorText}>{error}</AppText></View>}
      {settingsPane && savedAt && (
        <Animated.View style={{ opacity: bannerAnim, transform: [{ translateY: bannerAnim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }] }}>
        <View style={s.savedBanner}>
          <Ionicons name="checkmark-circle" size={14} color={tint.onEmerald} />
          <AppText style={s.savedBannerText}>已保存 {fmtHm(savedAt)}</AppText>
        </View>
        </Animated.View>
      )}
      {settingsPane === '关于本应用' && <View style={[s.aboutPanel, { backgroundColor: themeColors.surface, borderColor: themeColors.borderSubtle }]}>
        <View style={[s.aboutIcon, { backgroundColor: themeColors.primarySoft }]}><Ionicons name="bicycle-outline" size={28} color={themeColors.primary} /></View>
        <AppText style={[s.aboutName, { color: themeColors.textPrimary }]}>Nine Dashboard</AppText>
        <AppText style={[s.aboutVersion, { color: themeColors.textMuted }]}>版本 {curVersion || '—'}{curBuild != null ? ` · build ${curBuild}` : ''}</AppText>
        <View style={[s.aboutDivider, { backgroundColor: themeColors.borderSubtle }]} />
        <AppText style={[s.aboutDescription, { color: themeColors.textSecondary }]}>智能电动车数据、状态与设备管理应用。</AppText>
      </View>}

      {/* ── 通知 ── */}
      <Section visible={settingsPane === '通知设置'} icon="notifications-outline" title="通知" anim={sectionAnims[0]} badge={`${enabledNotifCount} 项开启`} badgeTone={enabledNotifCount > 0 ? 'emerald' : 'gray'}
        open={!!openSections.notify} onToggle={() => toggleSection('notify')}>
        {!notifPerm && (
          <Pressable style={s.permBanner} onPress={async () => {
            const granted = await requestNotificationPermission();
            setNotifPerm(granted);
            if (!granted) await openNotificationSettings();
          }}>
            <Ionicons name="alert-circle-outline" size={15} color={tint.onWarning} />
            <AppText style={s.permBannerText}>系统通知权限或“车辆事件”渠道未开启，点击处理</AppText>
          </Pressable>
        )}
        {!exactAlarmOk && (
          <Pressable style={s.permBanner} onPress={() => { void openExactAlarmSettings(); }}>
            <Ionicons name="alarm-outline" size={15} color={tint.onWarning} />
            <AppText style={s.permBannerText}>后台提醒会被系统延迟，点击开启“闹钟和提醒”权限</AppText>
          </Pressable>
        )}
        <NotifRow label="开始充电" sub="检测到未充电 → 充电时提醒" value={notifPrefs.chargeStart} onChange={v => { void toggleNotif('chargeStart', v); }} />
        <NotifRow label="充电结束" sub="检测到充电 → 停止时提醒" value={notifPrefs.chargeEnd} onChange={v => { void toggleNotif('chargeEnd', v); }} />
        <NotifRow label="电池温度过高" sub="温度首次越过高温预警线时提醒" value={notifPrefs.tempHigh} onChange={v => { void toggleNotif('tempHigh', v); }} hintKey="temp_warn" />
        <NotifRow label="低电量提醒" sub="统一 SOC 首次跌破阈值时提醒" value={notifPrefs.lowBattery} onChange={v => { void toggleNotif('lowBattery', v); }} hintKey="low_battery_notify" />
        <NotifRow label="萤石监控告警" sub="后台发现新的告警编号时提醒" value={notifPrefs.ezvizAlarm} onChange={v => { void toggleNotif('ezvizAlarm', v); }} />
        <Pressable style={s.btnGhost} onPress={() => { void testNotifications(); }} disabled={notifBusy}>
          <Ionicons name="notifications-outline" size={16} color={colors.text} />
          <AppText style={s.btnGhostText}>{notifBusy ? '正在发送…' : '发送一条测试通知'}</AppText>
        </Pressable>
        {notifMsg ? <AppText style={s.okSmall}>{notifMsg}</AppText> : null}
        {notifErr ? <AppText style={s.errSmall}>{notifErr}</AppText> : null}
        <AppText style={s.hint}>仅在状态发生变化时提醒，不会持续重复打扰。</AppText>
      </Section>

      {/* ── 首页体验 ── */}
      <Section visible={settingsPane === '数据设置'} icon="options-outline" title="首页与数据" anim={sectionAnims[5]} badge={tipPrefs.enabled ? '提示已开' : '提示已关'} badgeTone={tipPrefs.enabled ? 'emerald' : 'gray'}
        open={!!openSections.home} onToggle={() => toggleSection('home')}>
        <AppText style={s.label}>首页自动刷新间隔</AppText>
        <View style={s.chipRow}>
          {[60, 300, 600, 900].map(sv => (
            <Pressable key={sv} style={[s.chip, homeSec === sv && s.chipActive]}
              onPress={() => { setHomeSec(sv); void setHomeRefreshSec(sv); }}>
              <AppText style={[s.chipText, homeSec === sv && s.chipTextActive]}>{sv < 60 ? `${sv} 秒` : `${sv / 60} 分钟`}</AppText>
            </Pressable>
          ))}
        </View>
        <AppText style={s.hint}>数据来自九号云端；建议 5 分钟，60 秒仅适合临时盯车。保护板实时读数请查看“仪表板”页，不需要为它缩短此间隔。</AppText>

        <View style={s.subDivider} />
        <AppText style={s.subTitle}>首页动态提示</AppText>
        <NotifRow label="显示首页提示" value={tipPrefs.enabled} onChange={v => toggleTip('enabled', v)} hintKey="tip_master" />
        <View style={s.subGroup}>
          <NotifRow label="异常提示" sub="温度过热、电量过低等关键告警" value={tipPrefs.anomaly} onChange={v => toggleTip('anomaly', v)} hintKey="tip_anomaly" />
          <NotifRow label="智能提示" sub="充电中、电量充足、板已连接等" value={tipPrefs.smart} onChange={v => toggleTip('smart', v)} hintKey="tip_smart" />
          <NotifRow label="天气提示" sub="根据车辆位置给出当日天气" value={tipPrefs.weather} onChange={v => toggleTip('weather', v)} hintKey="tip_weather" />
        </View>
        <AppText style={s.hint}>异常提示优先级最高，开启时始终优先显示；天气提示为兜底。关闭「显示首页提示」后三者均不显示。</AppText>

        <View style={s.subDivider} />
        <AppText style={s.subTitle}>低电量提醒阈值</AppText>
        <View style={s.chipRow}>
          {[5, 10, 15, 20].map(pv => (
            <Pressable key={pv} style={[s.chip, lowBattPct === pv && s.chipActive]}
              onPress={() => { setLowBattPct(pv); void setLowBatteryPct(pv); }}>
              <AppText style={[s.chipText, lowBattPct === pv && s.chipTextActive]}>{pv}%</AppText>
            </Pressable>
          ))}
        </View>
        <AppText style={s.hint}>电量（SOC%）低于该值时，首页给出低电量提示；若开启「低电量提醒」通知，还会推送系统通知。</AppText>

        <View style={s.subDivider} />
        <AppText style={s.subTitle}>温度阈值</AppText>
        <View style={[s.grid2, { gap: rs.gridGap }]}>
          <NumField label="高温预警 (°C)" value={String(tempWarn)} onChange={v => { const n = Number(v); if (Number.isFinite(n)) { setTempWarn(n); void setTempWarnC(n); } }} hintKey="temp_warn" />
          <NumField label="严重过热 (°C)" value={String(tempDanger)} onChange={v => { const n = Number(v); if (Number.isFinite(n)) { setTempDanger(n); void setTempDangerC(n); } }} hintKey="temp_danger" />
        </View>
        <AppText style={s.hint}>高温预警同时是「温度过高」通知的触发线；严重过热用于卡片/首页最醒目告警。两处温度着色与通知均跟随这两个值。</AppText>

        <View style={s.subDivider} />
        <AppText style={s.subTitle}>地图缩放级别</AppText>
        <View style={s.chipRow}>
          {[12, 15, 18].map(zv => (
            <Pressable key={zv} style={[s.chip, mapZoom === zv && s.chipActive]}
              onPress={() => { setMapZoom(zv); void setMapZoom(zv); }}>
              <AppText style={[s.chipText, mapZoom === zv && s.chipTextActive]}>{zv} 级</AppText>
            </Pressable>
          ))}
        </View>
        <AppText style={s.hint}>首页静态地图的缩放等级，数值越大地图越详细、视野越小。</AppText>

        <View style={s.subDivider} />
        <AppText style={s.subTitle}>GPS 实时车速（仪表板）</AppText>
        <NotifRow
          label="启用 GPS 车速"
          sub="默认关闭省电。关闭时 App 完全不发起定位调用；开启后仅仪表板页前台时采样。室内/楼内 GPS 飘速属物理限制"
          value={gpsSpeedOn}
          onChange={v => { setGpsSpeedOn(v); void setGpsSpeedEnabled(v); }}
        />
      </Section>

      {/* ── 连接与账号 ── */}
      <Section visible={settingsPane === '九号账号'} icon="link-outline" title="连接与账号" anim={sectionAnims[1]} badge={nbAccount ? '九号已登录' : '九号未登录'} badgeTone={nbAccount ? 'emerald' : 'amber'}
        open={!!openSections.connect} onToggle={() => toggleSection('connect')}>
        <AppText style={s.subTitle}>九号账号</AppText>
        {nbAccount ? (
          <View style={s.nbStatusBox}>
            <AppText style={s.nbStatusTitle}>{nbAccount.username || nbAccount.phone || '已连接'}</AppText>
            {!!nbAccount.phone && <AppText style={s.nbStatusSub}>手机 {nbAccount.phone}</AppText>}
            <AppText style={s.hint}>Token 保存在服务器 ninecli 中。迁移到新机器后需重新登录一次。</AppText>
          </View>
        ) : (
          <AppText style={s.hint}>服务器尚未绑定九号账号，车辆数据无法拉取。请在下方登录。</AppText>
        )}

        <View style={s.autoLoginBox}>
          <View style={s.autoLoginHead}>
            <View style={s.autoLoginIcon}><Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} /></View>
            <View style={{ flex: 1 }}>
              <AppText style={s.autoLoginTitle}>安全自动续登</AppText>
              <AppText style={s.autoLoginSub}>
                {nbAutoLogin.blocked
                  ? '上次自动登录失败，已暂停；手动登录成功后恢复'
                  : nbAutoLogin.ready
                    ? `凭据仅保存在本机安全区${nbAutoLogin.account ? ` · ${nbAutoLogin.account}` : ''}`
                    : '遇到授权失效时自动尝试一次，不会上传密码到服务器'}
              </AppText>
            </View>
            <Switch
              value={nbAutoLogin.enabled}
              onValueChange={v => { void toggleNinebotAutoLogin(v); }}
              trackColor={{ false: colors.border, true: colors.primaryLight }}
              thumbColor={nbAutoLogin.enabled ? colors.primary : '#f4f3f4'}
            />
          </View>
          <AppText style={s.autoLoginNote}>关闭会立即删除本机密码；验证码、人机验证或密码变更仍需手动处理。</AppText>
        </View>

        <View style={s.modeRow}>
          <Pressable
            style={[s.modeBtn, nbMode === 'password' && s.modeBtnActive]}
            onPress={() => { setNbMode('password'); setNbErr(null); setNbMsg(null); }}
          >
            <AppText style={[s.modeBtnText, nbMode === 'password' && s.modeBtnTextActive]}>密码登录</AppText>
          </Pressable>
          <Pressable
            style={[s.modeBtn, nbMode === 'sms' && s.modeBtnActive]}
            onPress={() => { setNbMode('sms'); setNbErr(null); setNbMsg(null); }}
          >
            <AppText style={[s.modeBtnText, nbMode === 'sms' && s.modeBtnTextActive]}>短信登录</AppText>
          </Pressable>
        </View>

        <AppText style={s.label}>{nbMode === 'sms' ? '手机号' : '账号（手机号/昵称）'}</AppText>
        <TextInput
          style={s.input}
          value={nbUser}
          onChangeText={setNbUser}
          placeholder={nbMode === 'sms' ? '11 位手机号' : '手机号或昵称'}
          placeholderTextColor={colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={nbMode === 'sms' ? 'phone-pad' : 'default'}
        />

        {nbMode === 'password' ? (
          <>
            <AppText style={s.label}>密码</AppText>
            <TextInput
              style={s.input}
              value={nbPassword}
              onChangeText={setNbPassword}
              placeholder="九号 App 密码"
              placeholderTextColor={colors.textDim}
              secureTextEntry
              autoCapitalize="none"
            />
            {nbErr && <AppText style={s.errSmall}>{nbErr}</AppText>}
            {nbMsg && <AppText style={s.okSmall}>{nbMsg}</AppText>}
            <Pressable
              style={({ pressed }) => [s.btnGreen, pressed && { opacity: 0.8 }, nbBusy && { opacity: 0.5 }]}
              onPress={handleNinebotPasswordLogin}
              disabled={nbBusy}
            >
              <AppText style={s.btnText}>{nbBusy ? '登录中…' : (nbAccount ? '重新登录' : '登录九号账号')}</AppText>
            </Pressable>
          </>
        ) : (
          <>
            <AppText style={s.label}>验证码</AppText>
            <View style={s.codeRow}>
              <TextInput
                style={[s.input, { flex: 1, marginTop: 0 }]}
                value={nbCode}
                onChangeText={setNbCode}
                placeholder="短信验证码"
                placeholderTextColor={colors.textDim}
                keyboardType="number-pad"
                autoCapitalize="none"
              />
              <Pressable
                style={({ pressed }) => [s.codeBtn, pressed && { opacity: 0.8 }, (nbBusy || codeCooldown > 0) && { opacity: 0.5 }]}
                onPress={handleNinebotSendCode}
                disabled={nbBusy || codeCooldown > 0}
              >
                <AppText style={s.codeBtnText}>
                  {codeCooldown > 0 ? `重发 (${codeCooldown}s)` : nbCodeSent ? '重发' : '获取验证码'}
                </AppText>
              </Pressable>
            </View>
            {nbErr && <AppText style={s.errSmall}>{nbErr}</AppText>}
            {nbMsg && <AppText style={s.okSmall}>{nbMsg}</AppText>}
            <Pressable
              style={({ pressed }) => [s.btnGreen, pressed && { opacity: 0.8 }, nbBusy && { opacity: 0.5 }]}
              onPress={handleNinebotCodeLogin}
              disabled={nbBusy}
            >
              <AppText style={s.btnText}>{nbBusy ? '登录中…' : (nbAccount ? '重新登录' : '验证并登录')}</AppText>
            </Pressable>
          </>
        )}
        <View style={s.subDivider} />
        <AppText style={s.subTitle}>服务器地址</AppText>
        <TextInput style={s.input} value={serverUrl} onChangeText={setServerUrl}
          placeholder="https://example.com" placeholderTextColor={colors.textDim} autoCapitalize="none" autoCorrect={false} />
        <AppText style={s.hint}>局域网可使用 http://192.0.2.10:8000；公网请使用你自己的 HTTPS 域名。萤石云密钥在服务器 .env 中配置（EZVIZ_APP_KEY / EZVIZ_APP_SECRET），App 内不保存。</AppText>
        <Pressable style={({ pressed }) => [s.btn, pressed && { opacity: 0.8 }, serverSaved && { backgroundColor: colors.accentGreen }]} onPress={saveServerConfig} disabled={savingServer}>
          <AppText style={s.btnText}>{savingServer ? '保存中…' : serverSaved ? '已保存' : '保存配置'}</AppText>
        </Pressable>

        <View style={s.subDivider} />
        <AppText style={s.subTitle}>仪表盘密码</AppText>
        <TextInput style={s.input} placeholder="当前密码" placeholderTextColor={colors.textDim} value={curPw} onChangeText={setCurPw} secureTextEntry />
        <TextInput style={s.input} placeholder="新密码（至少 8 位）" placeholderTextColor={colors.textDim} value={newPw} onChangeText={setNewPw} secureTextEntry />
        <TextInput style={s.input} placeholder="确认新密码" placeholderTextColor={colors.textDim} value={confirmPw} onChangeText={setConfirmPw} secureTextEntry />
        {pwErr && <AppText style={s.errSmall}>{pwErr}</AppText>}
        {pwMsg && <AppText style={s.okSmall}>{pwMsg}</AppText>}
        <Pressable style={({ pressed }) => [s.btnDark, pressed && { opacity: 0.8 }]} onPress={handleChangePassword} disabled={pwSaving}>
          <AppText style={s.btnText}>{pwSaving ? '修改中...' : '修改密码'}</AppText>
        </Pressable>

        <View style={s.subDivider} />
        <Pressable style={({ pressed }) => [s.btn, s.btnLogout, pressed && { opacity: 0.8 }]} onPress={() => { logout(); router.replace('/login'); }}>
          <AppText style={s.btnText}>退出登录</AppText>
        </Pressable>
      </Section>

      {/* ── 车辆 ── */}
      {vehicle && (
        <Section visible={settingsPane === '车辆设置'} icon="bicycle-outline" title="车辆" anim={sectionAnims[2]} badge={vehicle.name} badgeTone="gray"
          open={!!openSections.vehicle} onToggle={() => toggleSection('vehicle')}>
          <View style={[s.grid2, { gap: rs.gridGap }]}>
            <ReadOnlyField label="型号" value={vehicle.model} />
            <ReadOnlyField label="中文名" value={vehicle.vehicle_name_zh} />
            <ReadOnlyField label="颜色" value={vehicle.color} />
            <ReadOnlyField label="SN" value={vehicle.sn} />
          </View>
          {data && (
            <>
              <View style={s.subDivider} />
              <AppText style={s.subTitle}>总里程基线{data.odometer_baseline_km != null ? '' : '（未设置）'}</AppText>
          <View style={[s.grid2, { gap: rs.gridGap }]}>
            <NumField label="表显总里程 (km)" value={odometerEdit} onChange={setOdometerEdit} hintKey="odometer_baseline" />
          </View>
              <AppText style={s.hint}>上游接口不提供车辆总里程，这里输入九号 App 里看到的当前总里程作为基线，之后系统用已同步的骑行里程自动累加。每次重新输入会以当前时刻重新开始累加。</AppText>
              <Pressable style={({ pressed }) => [s.btnGreen, pressed && { opacity: 0.8 }]} onPress={saveOdometer} disabled={savingOdometer}>
                <AppText style={s.btnText}>{savingOdometer ? '保存中…' : '保存基线'}</AppText>
              </Pressable>
            </>
          )}
        </Section>
      )}

      {/* ── 中继手机 ── */}
      {vehicle && (
        <Section visible={settingsPane === '中继设备'} icon="phone-portrait-outline" title="中继与数据采样" anim={sectionAnims[6]}
          badge={relayStatus ? (relayStatus.connected ? '在线' : '离线') : undefined}
          badgeTone={relayStatus?.connected ? 'emerald' : 'gray'}
          open={!!openSections.relay} onToggle={() => toggleSection('relay')}>

          {/* 实时状态 */}
          <AppText style={s.subTitle}>实时状态</AppText>
          <View style={[s.grid2, { gap: rs.gridGap }]}>
            <ReadOnlyField label="中继连接" value={relayStatus ? (relayStatus.connected ? '在线' : '离线') : '—'} />
            <ReadOnlyField label="保护板" value={relayStatus ? (
              relayStatus.board_state === 'live' ? '实时已连接'
                : relayStatus.board_state === 'connected_stale' ? `已连接 · 数据 ${fmtAgo(relayStatus.board_frame_age_seconds)}`
                : relayStatus.board_state === 'disconnected' ? '未连接'
                : '中继离线'
            ) : '—'} />
            <ReadOnlyField label="最后上报" value={fmtAgo(relayStatus?.age_seconds ?? null)} />
            <ReadOnlyField label="手机电量" value={relayStatus?.phone_battery_level_pct != null ? `${relayStatus.phone_battery_level_pct}%` : '—'} />
            <ReadOnlyField label="APK 版本" value={relayStatus?.app_ver ?? '—'} />
          </View>
          <AppText style={s.hint}>
            待传条数仅中继本机可见，服务端不掌握；缓存变化要等中继连热点回传后才能在首页看到。
            {relayStatus?.ambient ? ` · 温湿度 ${relayStatus.ambient.temp_c?.toFixed(1)}°C / ${relayStatus.ambient.humidity_pct?.toFixed(0)}%` : ''}
          </AppText>
          <Pressable style={[s.btnGhost, rs.landscape && { flex: 1 }]} onPress={() => loadRelay(vehicle.sn)}>
            <Ionicons name="refresh-outline" size={15} color={colors.text} />
            <AppText style={s.btnGhostText}>刷新状态</AppText>
          </Pressable>

          <View style={s.subDivider} />

          {/* ① 数据采样与保存 */}
          <AppText style={s.subTitle}>① 保护板采样与数据保存</AppText>
          <AppText style={s.hint}>保护板 BLE 保活由中继固定在最多 30 秒一次，低功耗也不会放慢，避免蚂蚁保护板休眠后失联。下面只调整需要保存/上传的数据密度。</AppText>

          <AppText style={s.fieldLabel}>
            骑行时采样间隔：{rideMs >= 1000 ? `${(rideMs / 1000).toFixed(rideMs % 1000 ? 1 : 0)} 秒` : `${rideMs} 毫秒`}（推荐 1 秒 / 1 Hz）
          </AppText>
          <PresetSlider options={RIDE_INTERVALS_MS} value={rideMs} recommended={1000}
            onChange={setRideMs} format={formatRideInterval} />
          <AppText style={s.hint}>骑行中读取保护板数据的间隔。1 Hz 是甜点：功率曲线足够细腻、链路稳健（已加 BLE 高连接优先级），且不会因过密增加射频碰撞。续航吃紧可放宽到 2–3 秒，代价是曲线变粗、短暂掉帧。不建议低于 1 秒。</AppText>

          <AppText style={s.fieldLabel}>
            停车时保存/上传间隔：{idleSec >= 60 ? `${(idleSec / 60).toFixed(idleSec % 60 ? 1 : 0)} 分钟` : `${idleSec} 秒`}（推荐 2 分钟）
          </AppText>
          <PresetSlider options={IDLE_INTERVALS_SEC} value={idleSec} recommended={120}
            onChange={setIdleSec} format={formatSecondsCompact} />
          <AppText style={s.hint}>停车且数值无明显变化时，多久保留并上传一条记录。推荐 2 分钟，可显著减少 Wi‑Fi/CPU 唤醒；电量、电流或温度发生明显变化仍会立即记录。此设置不影响保护板连接保活。</AppText>

          <View style={s.subDivider} />

          {/* ② 上报与监测节奏 */}
          <AppText style={s.subTitle}>② 上报与监测节奏</AppText>
          <AppText style={s.hint}>这两项决定「中继多久和服务器交流一次」，直接影响远控指令的响应速度，以及仪表盘上中继遥测的及时性。</AppText>

          <AppText style={s.fieldLabel}>
            停车远控检查间隔：{pollSec} 秒（推荐 60 秒）
          </AppText>
          <PresetSlider options={RELAY_POLL_INTERVALS_SEC} value={pollSec} recommended={60}
            onChange={setPollSec} format={v => `${v} 秒`} />
          <AppText style={s.hint}>停车时推荐 60 秒，可将每天约 2.9 万次网络唤醒降到约 1440 次。检测到骑行后自动缩短到最多 15 秒；保护板采样与此设置完全独立。</AppText>

          <AppText style={s.fieldLabel}>
            停车后高频监测时长：{monitorSec === 0 ? '停车即降频' : (monitorSec >= 60 ? `${(monitorSec / 60).toFixed(monitorSec % 60 ? 1 : 0)} 分钟` : `${monitorSec} 秒`)}（推荐 3 分钟）
          </AppText>
          <PresetSlider options={MONITOR_INTERVALS_SEC} value={monitorSec} recommended={180}
            onChange={setMonitorSec} format={formatSecondsCompact} />
          <AppText style={s.hint}>停车后仍按「骑行级」高频采样/上报的保持时间。用于避免红绿灯、短暂下车等「假停车」被误判为停车而丢失细节数据。推荐 3 分钟；设为 0 则一停即降频（最省电，但可能丢短暂停车数据）。</AppText>

          <View style={s.subDivider} />

          {/* ③ 省电与配件 */}
          <AppText style={s.subTitle}>③ 省电与配件</AppText>
          <NotifRow label="增强省电模式" sub="降低停车网络与传感器扫描功耗；不会降低保护板 30 秒保活频率，推荐尾箱长期值守时开启" value={lowPower} onChange={setLowPower} />
          <AppText style={s.fieldLabel}>温湿度计 MAC（可选）</AppText>
          <TextInput style={s.fieldInput} value={thermoMac} onChangeText={setThermoMac}
            placeholder="AA:BB:CC:DD:EE:FF" placeholderTextColor={colors.textDim}
            autoCapitalize="characters" />
          <AppText style={s.hint}>米家温湿度计（LYWSD03MMC / pvvx 固件）的蓝牙 MAC，留空则不采集环境温湿度。注意：尾箱无 SIM，温湿度数据要等中继连到热点回传后才能在首页看到。</AppText>

          <Pressable style={[s.btnGreen, rs.landscape && { alignSelf: 'flex-start' }]} onPress={saveRelayConfig} disabled={savingRelayCfg}>
            <AppText style={s.btnText}>{savingRelayCfg ? '保存中…' : '保存中继配置'}</AppText>
          </Pressable>
          <Pressable style={[{ borderWidth: 1, borderColor: colors.border, paddingVertical: 12, borderRadius: radius.lg, alignItems: 'center', marginTop: spacing.sm }]} onPress={restoreRecommendedRelay}>
            <AppText style={[s.btnText, { color: colors.primary }]}>恢复推荐值</AppText>
          </Pressable>
          <AppText style={s.hint}>推荐值：骑行 1 秒 · 停车 30 秒 · 轮询 3 秒 · 监测 3 分钟——在「骑行稳定性 / 数据新鲜度 / 中继续航」间取得平衡。改完记得点上方「保存中继配置」。</AppText>
          {relayMsg ? <AppText style={s.okSmall}>{relayMsg}</AppText> : null}
          {relayErr ? <AppText style={s.errSmall}>{relayErr}</AppText> : null}

          <View style={s.subDivider} />

          {/* 远控指令 */}
          <AppText style={s.subTitle}>远控指令</AppText>
          {/* 自助固件更新：点一次 S7 自动下载安装，无需去尾箱 USB 连线 */}
          <Pressable
            style={[s.btnGreen, relayCmdBusy === 'update_apk' && s.btnGhostBusy, relayCmdBusy && s.btnGhostDisabled]}
            disabled={!!relayCmdBusy}
            onPress={() => sendRelayCommand('update_apk')}
          >
            <Ionicons name="download-outline" size={16} color="#fff" />
            <AppText style={s.btnText}>更新中继固件</AppText>
          </Pressable>
          <AppText style={s.hint}>
            点击让 S7 自动下载并静默安装最新中继固件，无需 USB 连线。下发后约 10–30 秒完成、自动重启（期间勿关闭中继）。
            仅当 S7 已装含自更新能力的新版时有效；旧版中继不识别此指令。
          </AppText>
          <View style={s.relayCmdRow}>
            <Pressable style={[s.btnGhost, relayCmdBusy === 'photo' && s.btnGhostBusy, relayCmdBusy && s.btnGhostDisabled]} disabled={!!relayCmdBusy} onPress={() => sendRelayCommand('photo', { facing: 'back' })}>
              <Ionicons name="camera-outline" size={16} color={colors.text} />
              <AppText style={s.btnGhostText}>立即拍照</AppText>
            </Pressable>
            <Pressable style={[s.btnGhost, relayCmdBusy === 'flush' && s.btnGhostBusy, relayCmdBusy && s.btnGhostDisabled]} disabled={!!relayCmdBusy} onPress={() => sendRelayCommand('flush')}>
              <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
              <AppText style={s.btnGhostText}>立即回传</AppText>
            </Pressable>
          </View>
          <View style={s.relayCmdRow}>
            <Pressable style={[s.btnGhost, relayCmdBusy === 'restart' && s.btnGhostBusy, relayCmdBusy && s.btnGhostDisabled]} disabled={!!relayCmdBusy} onPress={() => sendRelayCommand('restart')}>
              <Ionicons name="reload-outline" size={16} color={colors.text} />
              <AppText style={s.btnGhostText}>重启中继</AppText>
            </Pressable>
            <Pressable style={[s.btnGhost, relayCmdBusy === 'clear-backlog' && s.btnGhostBusy, relayCmdBusy && s.btnGhostDisabled]} disabled={!!relayCmdBusy} onPress={confirmClearBacklog}>
              <Ionicons name="trash-outline" size={16} color={colors.text} />
              <AppText style={s.btnGhostText}>清空缓存</AppText>
            </Pressable>
          </View>
          <AppText style={s.hint}>指令异步下发：中继通常会在当前轮询间隔（约 {pollSec} 秒）内取走执行。重启 / 清空不可撤销，请确认后再点。</AppText>
        </Section>
      )}

      {/* 电池硬件档案：只保留真实、可核验的规格参数。 */}
      {data && (
        <Section visible={settingsPane === '电池硬件档案'} icon="battery-charging-outline" title="电池硬件档案" anim={sectionAnims[3]} badge="保护板优先" badgeTone="emerald"
          open={!!openSections.calibration} onToggle={() => toggleSection('calibration')}>

          <AppText style={s.subTitle}>BMS 硬件信息</AppText>
          <View style={[s.grid2, { gap: rs.gridGap }]}>
            <ReadOnlyField label="化学类型" value={data.readonly.chemistry_type} />
            <ReadOnlyField label="串联数" value={data.readonly.cell_series_count != null ? `${data.readonly.cell_series_count}S` : null} />
          </View>

          <View style={s.subDivider} />
          <AppText style={s.subTitle}>基础规格{data.priors_set_at ? '' : '（未设置）'}</AppText>
          <View style={[s.grid2, { gap: rs.gridGap }]}>
            {Object.keys(PRIOR_LABELS).map(k => (
              <NumField key={k} label={PRIOR_LABELS[k]} value={priorsEdit[k] ?? ''}
                onChange={v => setPriorsEdit(s => ({ ...s, [k]: v }))} hintKey={PRIOR_HINTS[k]} />
            ))}
          </View>
          <AppText style={s.hint}>保护板在线时，SOC、电压、电流、功率和容量全部使用实测值；这些规格只用于中继掉线后的保守降级和充电器额定值说明。</AppText>
          <Pressable style={({ pressed }) => [s.btnGreen, pressed && { opacity: 0.8 }]} onPress={savePriors} disabled={savingPriors}>
            <AppText style={s.btnText}>{savingPriors ? '保存中…' : '保存电池档案'}</AppText>
          </Pressable>
        </Section>
      )}

      {/* ── 桌面小组件 ── */}
      <Section visible={settingsPane === '桌面小组件'} icon="grid-outline" title="桌面小组件" anim={sectionAnims[4]} badge={`每 ${widgetMin} 分钟`} badgeTone="emerald"
        open={!!openSections.widget} onToggle={() => toggleSection('widget')}>
        <AppText style={s.label}>主题行为</AppText>
        <View style={s.chipRow}>
          {([{ id: 'app', label: '跟随 App' }, { id: 'system', label: '跟随系统' }] as const).map(item => (
            <Pressable key={item.id} style={[s.chip, widgetBehavior === item.id && s.chipActive]} onPress={() => { setWidgetBehaviorState(item.id); void setWidgetThemeBehavior(item.id); }}>
              <AppText style={[s.chipText, widgetBehavior === item.id && s.chipTextActive]}>{item.label}</AppText>
            </Pressable>
          ))}
        </View>
        <AppText style={s.hint}>主题包始终使用 App 当前选择；“跟随系统”只让小组件独立响应 Android 深浅模式。独立指定主题的数据结构已预留，后续再开放选择界面。</AppText>
        <View style={s.subDivider} />
        <AppText style={s.label}>自动刷新间隔（无需打开 App）</AppText>
        {!exactAlarmOk && (
          <View style={[s.banner, s.bannerWarn]}>
            <Ionicons name="alarm-outline" size={18} color={colors.danger} style={{ marginRight: spacing.sm }} />
            <View style={{ flex: 1 }}>
              <AppText style={[s.bannerTitle, { color: colors.danger }]}>后台刷新被系统限制</AppText>
              <AppText style={s.bannerText}>
                Android 12+ 需要「闹钟和提醒」权限，小组件才能在息屏后准时自刷新。未开启时刷新会被系统批量延迟，只有亮屏/打开 App 才更新。
              </AppText>
              <Pressable
                style={({ pressed }) => [s.btnDanger, pressed && { opacity: 0.8 }]}
                onPress={() => { void openExactAlarmSettings(); }}
              >
                <AppText style={s.btnText}>去开启「闹钟和提醒」权限</AppText>
              </Pressable>
            </View>
          </View>
        )}
        {nested ? (
          <Pressable onPress={() => router.push('/(tabs)/more/widget/refresh-rate')} style={({ pressed }) => [s.settingsLinkRow, { backgroundColor: themeColors.surfaceSecondary }, pressed && { opacity: 0.78 }]}>
            <View style={{ flex: 1 }}><AppText style={[s.settingsLinkTitle, { color: themeColors.textPrimary }]}>刷新频率</AppText><AppText style={[s.settingsLinkHint, { color: themeColors.textMuted }]}>小组件后台自动刷新</AppText></View>
            <AppText style={[s.settingsLinkValue, { color: themeColors.primary }]}>{widgetMin} 分钟</AppText><Ionicons name="chevron-forward" size={16} color={themeColors.textDim} />
          </Pressable>
        ) : (
          <View style={s.chipRow}>
            {[1, 5, 10, 15, 30].map(m => (
              <Pressable
                key={m}
                style={[s.chip, widgetMin === m && s.chipActive]}
                onPress={() => { setWidgetMin(m); void setWidgetRefreshInterval(m); }}
              >
                <AppText style={[s.chipText, widgetMin === m && s.chipTextActive]}>{m} 分钟</AppText>
              </Pressable>
            ))}
          </View>
        )}
        <AppText style={s.hint}>间隔越短越及时、越耗电。1 分钟档需要开启“闹钟和提醒”权限才能尽量准时；未授权或处于深度省电时，系统可能合并刷新。小组件右上角的 ↻ 可随时手动刷新。</AppText>
      </Section>

      {/* ── 应用更新 ── */}
      <Section visible={settingsPane === '高级设置'} icon="cloud-download-outline" title="应用更新" anim={sectionAnims[7]}
        badge={hasUpdate ? '有更新' : (apkInfo?.exists ? '已最新' : undefined)} badgeTone={hasUpdate ? 'emerald' : 'gray'}
        open={!!openSections.update} onToggle={() => toggleSection('update')}>
        <AppText style={s.fieldLabel}>当前版本</AppText>
        <AppText style={s.fieldValue}>{curVersion || '—'}{curBuild != null ? `  (build ${curBuild})` : ''}</AppText>

        {updateChecking && <AppText style={s.hint}>检查更新中…</AppText>}

        {!updateChecking && apkInfo?.exists && hasUpdate && (
          <>
            <View style={s.subDivider} />
            <AppText style={s.subTitle}>最新可用</AppText>
            <AppText style={s.fieldValue}>{apkInfo.version || '—'}{apkInfo.build != null ? `  (build ${apkInfo.build})` : ''}</AppText>
            {apkInfo.published_at ? <AppText style={s.hint}>发布于 {new Date(apkInfo.published_at).toLocaleString()}</AppText> : null}
            {apkInfo.size ? <AppText style={s.hint}>大小 {(apkInfo.size / 1024 / 1024).toFixed(1)} MB</AppText> : null}

            {updateDownloading && (
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${Math.round(downloadFraction * 100)}%` }]} />
              </View>
            )}
            {updateDownloading && <AppText style={s.hint}>下载中 {Math.round(downloadFraction * 100)}%</AppText>}

            <Pressable
              style={({ pressed }) => [s.btnGreen, pressed && { opacity: 0.8 }, updateDownloading && { opacity: 0.5 }]}
              disabled={updateDownloading}
              onPress={() => void doUpdate()}
            >
              <Ionicons name="download-outline" size={16} color="#fff" />
              <AppText style={s.btnText}>{updateDownloading ? '下载中…' : '下载并更新'}</AppText>
            </Pressable>
          </>
        )}

        {!updateChecking && apkInfo?.exists && !hasUpdate && (
          <AppText style={s.okSmall}>已是最新版本</AppText>
        )}
        {!updateChecking && apkInfo && !apkInfo.exists && (
          <AppText style={s.hint}>服务器暂无发布版本。</AppText>
        )}

        {updateMsg ? <AppText style={s.okSmall}>{updateMsg}</AppText> : null}
        {updateErr ? <AppText style={s.errSmall}>{updateErr}</AppText> : null}

        <View style={s.relayCmdRow}>
          <Pressable style={[s.btnGhost, updateChecking && s.btnGhostDisabled]} disabled={updateChecking} onPress={() => void checkUpdate()}>
            <Ionicons name="refresh-outline" size={15} color={colors.text} />
            <AppText style={s.btnGhostText}>检查更新</AppText>
          </Pressable>
        </View>
        <AppText style={s.hint}>
          点击「下载并更新」把最新安装包下载到本机，再由系统安装器提示你点击安装（无需连电脑、无需 root）。
          三星 One UI 若开启「自动拦截器」会拦截侧载，安装时临时放行即可。安装包与已装 App 同签名，非同签名包会被系统拒绝。
        </AppText>
      </Section>
    </ScrollView>
  );
}

function SettingsIndex({ colors: c, themeSummary, notificationSummary, vehicleSummary, relaySummary, onTheme, onDisplay, onWidget, onNotifications, onVehicle, onData, onRelay, onMonitor, onAccount, onBattery, onAdvanced, onAbout }: {
  colors: ThemeColors; themeSummary: string; notificationSummary: string; vehicleSummary: string; relaySummary: string;
  onTheme: () => void; onDisplay: () => void; onWidget: () => void; onNotifications: () => void; onVehicle: () => void; onData: () => void;
  onRelay: () => void; onMonitor: () => void; onAccount: () => void; onBattery: () => void; onAdvanced: () => void; onAbout: () => void;
}) {
  const groups = [
    { title: '外观', rows: [
      ['主题中心', themeSummary, 'color-palette-outline', onTheme], ['显示', '深浅模式与系统外观', 'contrast-outline', onDisplay], ['桌面小组件', '刷新与显示设置', 'grid-outline', onWidget],
    ] },
    { title: '通知', rows: [['通知设置', notificationSummary, 'notifications-outline', onNotifications]] },
    { title: '车辆', rows: [
      ['车辆设置', vehicleSummary, 'bicycle-outline', onVehicle], ['数据设置', '首页、阈值与采样偏好', 'analytics-outline', onData], ['电池硬件档案', '保护板规格与校准', 'battery-charging-outline', onBattery],
    ] },
    { title: '设备与连接', rows: [
      ['中继设备', relaySummary, 'radio-outline', onRelay], ['监控', '车辆监控与告警截图', 'videocam-outline', onMonitor], ['九号账号', '账号、服务器与登录', 'person-circle-outline', onAccount],
    ] },
    { title: '系统', rows: [['高级设置', '应用更新与系统工具', 'construct-outline', onAdvanced], ['关于本应用', '版本与应用信息', 'information-circle-outline', onAbout]] },
  ] as const;
  return <View>
    {groups.map(group => <View key={group.title} style={s.settingsGroupWrap}>
      <AppText style={[s.settingsGroupTitle, { color: c.textMuted }]}>{group.title}</AppText>
      <View style={[s.settingsGroup, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
        {group.rows.map((row, index) => <Pressable key={row[0]} onPress={row[3]} style={({ pressed }) => [s.settingsRow, index > 0 && { borderTopWidth: 1, borderTopColor: c.borderSubtle }, pressed && { backgroundColor: c.surfaceSecondary }]}>
          <View style={[s.settingsRowIcon, { backgroundColor: c.primarySoft }]}><Ionicons name={row[2]} size={18} color={c.primary} /></View>
          <AppText style={[s.settingsRowLabel, { color: c.textPrimary }]}>{row[0]}</AppText>
          <AppText style={[s.settingsRowValue, { color: c.textMuted }]} numberOfLines={1}>{row[1]}</AppText>
          <Ionicons name="chevron-forward" size={17} color={c.textDim} />
        </Pressable>)}
      </View>
    </View>)}
  </View>;
}

/** Collapsible group — one Card per domain, header row toggles the body.
 *  The badge stays visible while collapsed so key status (login state,
 *  Wh/km, refresh interval) is readable at a glance. */
function Section({
  icon, title, badge, badgeTone, open, onToggle, anim, children, visible = true,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  badge?: string;
  badgeTone?: BadgeTone;
  open: boolean;
  onToggle: () => void;
  anim?: Animated.Value;
  children: React.ReactNode;
  visible?: boolean;
}) {
  const reveal = useReveal(open);
  const press = usePressScale(0.985);
  if (!visible) return null;
  return (
    <Animated.View style={anim ? enterStyle(anim) : undefined}>
      <Card style={s.cardSpacing}>
        <Animated.View style={press.pressStyle}>
          <Pressable onPress={onToggle} onPressIn={press.onPressIn} onPressOut={press.onPressOut}>
            <SectionHeader icon={icon} title={title} badge={badge} badgeTone={badgeTone} style={{ marginBottom: 0 }}
              accessory={(
                <Animated.View style={spinStyle(reveal)}>
                  <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
                </Animated.View>
              )} />
          </Pressable>
        </Animated.View>
        {open && (
          <Animated.View style={[{ marginTop: spacing.md }, revealStyle(reveal)]}>{children}</Animated.View>
        )}
      </Card>
    </Animated.View>
  );
}

function formatRideInterval(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Number((ms / 1000).toFixed(2))} 秒`;
}

function formatSecondsCompact(sec: number): string {
  if (sec === 0) return '立即降频';
  if (sec < 60) return `${sec} 秒`;
  return `${Number((sec / 60).toFixed(1))} 分钟`;
}

function PresetSlider({ options, value, recommended, onChange, format }: {
  options: number[];
  value: number;
  recommended: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
}) {
  const nearestIndex = options.reduce((best, option, index) =>
    Math.abs(option - value) < Math.abs(options[best] - value) ? index : best, 0);
  return (
    <View style={s.presetSliderBox}>
      <View style={s.sliderControlRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="减小刷新间隔"
          disabled={nearestIndex === 0}
          onPress={() => onChange(options[Math.max(0, nearestIndex - 1)])}
          style={[s.sliderStepButton, nearestIndex === 0 && { opacity: 0.35 }]}>
          <Ionicons name="remove" size={22} color={colors.primary} />
        </Pressable>
        <Slider
          style={s.presetSlider}
          minimumValue={0}
          maximumValue={options.length - 1}
          step={1}
          value={nearestIndex}
          onValueChange={index => onChange(options[Math.round(index)])}
          minimumTrackTintColor={colors.primary}
          maximumTrackTintColor={colors.border}
          thumbTintColor={colors.primary}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="增大刷新间隔"
          disabled={nearestIndex === options.length - 1}
          onPress={() => onChange(options[Math.min(options.length - 1, nearestIndex + 1)])}
          style={[s.sliderStepButton, nearestIndex === options.length - 1 && { opacity: 0.35 }]}>
          <Ionicons name="add" size={22} color={colors.primary} />
        </Pressable>
      </View>
      <View style={s.sliderLabels}>
        <AppText style={s.sliderEdgeLabel}>{format(options[0])}</AppText>
        <Pressable style={s.sliderRecommended} onPress={() => onChange(recommended)}>
          <Ionicons name="sparkles-outline" size={12} color={colors.primary} />
          <AppText style={s.sliderRecommendedText}>推荐 {format(recommended)}</AppText>
        </Pressable>
        <AppText style={[s.sliderEdgeLabel, { textAlign: 'right' }]}>{format(options[options.length - 1])}</AppText>
      </View>
    </View>
  );
}

function NotifRow({ label, sub, value, onChange, hintKey }: { label: string; sub?: string; value: boolean; onChange: (v: boolean) => void; hintKey?: HintKey }) {
  return (
    <View style={s.notifRow}>
      <View style={{ flex: 1, paddingRight: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <AppText style={s.notifLabel}>{label}</AppText>
          {hintKey && <InfoHint hintKey={hintKey} size={12} />}
        </View>
        {sub ? <AppText style={s.notifSub}>{sub}</AppText> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.border, true: colors.primaryLight }}
        thumbColor={value ? colors.primary : '#f4f3f4'}
      />
    </View>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={s.fieldBox}>
      <AppText style={s.fieldLabel}>{label}</AppText>
      <AppText style={s.fieldValue}>{value ?? '—'}</AppText>
    </View>
  );
}

function NumField({ label, value, onChange, hintKey }: { label: string; value: string; onChange: (v: string) => void; hintKey?: HintKey }) {
  return (
    <View style={s.fieldBox}>
      <View style={s.fieldLabelRow}>
        <AppText style={s.fieldLabel}>{label}</AppText>
        {hintKey && <InfoHint hintKey={hintKey} size={12} />}
      </View>
      <TextInput style={s.fieldInput} value={value} onChangeText={onChange}
        keyboardType="numeric" placeholder="—" placeholderTextColor={colors.textDim} />
    </View>
  );
}

function EcRow({ label, value, hintKey }: { label: string; value: string; hintKey?: HintKey }) {
  return <InfoRow label={label} value={value} hintKey={hintKey} />;
}

const s = StyleSheet.create({
  settingsNavHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  settingsBack: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  settingsTitle: { fontSize: fontSize.xxl, fontWeight: '800' },
  settingsSubtitle: { fontSize: fontSize.xs, marginTop: 2 },
  settingsGroupWrap: { marginBottom: spacing.lg },
  settingsGroupTitle: { fontSize: fontSize.xs, fontWeight: '700', marginLeft: spacing.md, marginBottom: spacing.sm },
  settingsGroup: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' },
  settingsRow: { minHeight: 57, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  settingsRowIcon: { width: 32, height: 32, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  settingsRowLabel: { fontSize: fontSize.md, fontWeight: '600' },
  settingsRowValue: { flex: 1, textAlign: 'right', fontSize: fontSize.xs },
  settingsLinkRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.lg, paddingHorizontal: spacing.md, marginTop: spacing.sm },
  settingsLinkTitle: { fontSize: fontSize.sm, fontWeight: '700' },
  settingsLinkHint: { fontSize: fontSize.xs, marginTop: 2 },
  settingsLinkValue: { fontSize: fontSize.sm, fontWeight: '800', fontFamily: fontMono },
  aboutPanel: { borderWidth: 1, borderRadius: radius.xl, padding: spacing.xxl, alignItems: 'center' },
  aboutIcon: { width: 62, height: 62, borderRadius: radius.xl, alignItems: 'center', justifyContent: 'center' },
  aboutName: { fontSize: fontSize.xl, fontWeight: '800', marginTop: spacing.md },
  aboutVersion: { fontSize: fontSize.sm, marginTop: 4 },
  aboutDivider: { width: '100%', height: 1, marginVertical: spacing.lg },
  aboutDescription: { fontSize: fontSize.sm, lineHeight: 21, textAlign: 'center' },
  appearanceGroupTitle: { fontSize: fontSize.xs, fontWeight: '700', marginLeft: spacing.sm, marginBottom: spacing.sm },
  appearanceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  appearanceIcon: { width: 38, height: 38, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  appearanceTitle: { fontSize: fontSize.md, fontWeight: '700' },
  appearanceSubtitle: { fontSize: fontSize.xs, marginTop: 2 },
  container: { flex: 1, backgroundColor: colors.bg },

  cardSpacing: { marginBottom: spacing.sm },
  categoryTabs: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  categoryTab: { flex: 1, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: radius.lg, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight },
  categoryTabActive: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  categoryTabText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  categoryTabTextActive: { color: colors.primary, fontWeight: '800' },
  settingsOverview: { flexDirection: 'row', gap: spacing.sm, padding: spacing.sm, marginBottom: spacing.lg, borderRadius: radius.xl, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight, ...shadow.card },
  overviewCell: { flex: 1, minHeight: 88, paddingVertical: spacing.md, alignItems: 'center', justifyContent: 'center', borderRadius: radius.lg, backgroundColor: colors.cardAlt },
  overviewValue: { marginTop: spacing.xs, fontSize: fontSize.lg, fontWeight: '800', color: colors.text },
  overviewValueSmall: { marginTop: spacing.xs, fontSize: fontSize.sm, fontWeight: '800', color: colors.text },
  overviewLabel: { marginTop: 2, fontSize: fontSize.xs, color: colors.textMuted },
  errorCard: { marginBottom: spacing.sm, backgroundColor: colors.dangerLight, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: tint.dangerBorder },
  errorText: { color: tint.onDanger, fontSize: fontSize.sm },

  grid2: { flexDirection: 'row', flexWrap: 'wrap' },
  fieldBox: { width: '47%' },
  fieldLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  fieldLabel: { fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: spacing.xs },
  fieldValue: { fontSize: fontSize.md, color: colors.text, fontFamily: fontMono },
  fieldInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 9, fontSize: fontSize.md, backgroundColor: colors.cardAlt, color: colors.text, fontFamily: fontMono },

  label: { fontSize: fontSize.sm, color: colors.text, marginTop: spacing.xs },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.md, backgroundColor: colors.cardAlt, color: colors.text, marginTop: 6 },

  btn: { backgroundColor: colors.primary, paddingVertical: 14, borderRadius: radius.lg, alignItems: 'center', marginTop: spacing.md },
  btnDark: { backgroundColor: colors.text, paddingVertical: 14, borderRadius: radius.lg, alignItems: 'center', marginTop: spacing.md },
  btnGreen: { backgroundColor: colors.accentGreen, paddingVertical: 14, borderRadius: radius.lg, alignItems: 'center', marginTop: spacing.md },
  adoptBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.primaryLight, paddingVertical: 10, borderRadius: radius.lg, marginTop: spacing.md },
  adoptBtnText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: '600' },
  btnLogout: { backgroundColor: colors.danger },
  btnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '600' },

  // 中继远控：浅色幽灵按钮，行内两两并排
  relayCmdRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  btnGhost: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.border, paddingVertical: 12, borderRadius: radius.lg },
  btnGhostText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  btnGhostBusy: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  btnGhostDisabled: { opacity: 0.5 },

  hint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 16 },
  errSmall: { fontSize: fontSize.sm, color: colors.danger, marginTop: 6 },
  okSmall: { fontSize: fontSize.sm, color: colors.accentGreen, marginTop: 6 },

  chipRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  progressTrack: { height: 6, backgroundColor: colors.border, borderRadius: 3, marginTop: spacing.sm, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: colors.primary, borderRadius: 3 },
  chip: { flex: 1, paddingVertical: 10, borderRadius: radius.lg, backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  chipActive: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  chipText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: colors.primary, fontWeight: '700' },

  presetSliderBox: { marginTop: 2, marginBottom: spacing.xs },
  sliderControlRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sliderStepButton: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primaryLight, borderWidth: 1, borderColor: colors.borderLight },
  presetSlider: { flex: 1, height: 48 },
  sliderLabels: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: -4 },
  sliderEdgeLabel: { width: '27%', fontSize: fontSize.xs, color: colors.textDim },
  sliderRecommended: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 9, paddingVertical: 5, borderRadius: radius.full, backgroundColor: colors.primaryLight },
  sliderRecommendedText: { fontSize: fontSize.xs, color: colors.primary, fontWeight: '700' },

  ecBox: { backgroundColor: colors.cardAlt, borderRadius: radius.lg, padding: spacing.md, gap: 6 },

  subTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: spacing.sm },
  subDivider: { height: 1, backgroundColor: colors.borderLight, marginVertical: spacing.md },

  savedBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tint.successSoft, borderRadius: radius.lg, paddingVertical: 8, paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  savedBannerText: { fontSize: fontSize.xs, color: tint.onEmerald, fontWeight: '600' },

  banner: { flexDirection: 'row', borderRadius: radius.lg, padding: spacing.md, marginTop: spacing.xs, marginBottom: spacing.sm },
  bannerWarn: { backgroundColor: colors.dangerLight, borderWidth: 1, borderColor: tint.dangerBorder },
  bannerTitle: { fontSize: fontSize.sm, fontWeight: '700', marginBottom: 2 },
  bannerText: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16, marginTop: 2, marginBottom: spacing.sm },
  btnDanger: { backgroundColor: colors.danger, paddingVertical: 10, borderRadius: radius.lg, alignItems: 'center', alignSelf: 'flex-start' },

  permBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.warningLight, borderRadius: radius.lg, paddingVertical: 9, paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  permBannerText: { fontSize: fontSize.xs, color: tint.onWarning, fontWeight: '600' },

  notifRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  subGroup: { marginLeft: spacing.lg, paddingLeft: spacing.md, borderLeftWidth: 2, borderLeftColor: colors.borderLight },
  notifLabel: { fontSize: fontSize.md, color: colors.text, fontWeight: '500' },
  notifSub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  nbStatusBox: { backgroundColor: colors.successLight, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.sm },
  nbStatusTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.accentGreen },
  nbStatusSub: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  autoLoginBox: { backgroundColor: colors.primaryLight, borderRadius: radius.lg, padding: spacing.md, marginTop: spacing.sm },
  autoLoginHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  autoLoginIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  autoLoginTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.primaryDark },
  autoLoginSub: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2, lineHeight: 16 },
  autoLoginNote: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 16 },
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, marginBottom: spacing.sm },
  modeBtn: { flex: 1, paddingVertical: 10, borderRadius: radius.lg, backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  modeBtnActive: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  modeBtnText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600' },
  modeBtnTextActive: { color: colors.primary },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 6 },
  codeBtn: { backgroundColor: colors.primary, paddingHorizontal: 12, paddingVertical: 12, borderRadius: radius.lg },
  codeBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '600' },
});
