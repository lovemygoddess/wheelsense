import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, Image, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppText } from '../../src/components/AppText';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../src/auth';
import { fetchTpms, fetchWeather, getBaseUrl, sendCommand, whoami, type AmapWeather, type AmapWeatherCast, type TpmsCurrent, type TpmsWheel } from '../../src/api';
import { wgs84ToGcj02 } from '../../src/coordTransform';
import { pushDashboardToWidget, getHomeRefreshSec, getTipPrefs, getLowBatteryPct, getTempWarnC, getTempDangerC, getMapZoom } from '../../src/widgetData';
import { ProgressRing, socRampColor, socRampText } from '../../src/components/ProgressRing';
import { LinearGradient } from '../../src/components/LinearGradient';
import { StatusPill } from '../../src/components/StatusPill';
import { EmptyState } from '../../src/components/EmptyState';
import { Skeleton, useShimmer } from '../../src/components/Skeleton';
import { Card } from '../../src/components/Card';
import { Grid } from '../../src/components/Grid';
import { InfoHint } from '../../src/components/InfoHint';
import { type HintKey } from '../../src/valueHints';
import { useHeaderTheme } from '../../src/hooks/useHeaderTheme';
import { useResponsive } from '../../src/hooks/useResponsive';
import { badgeTones, colors, fontMono, fontSize, headerThemes, radius, shadow, spacing, tint } from '../../src/theme';
import type { Account, RelayStatus, Snapshot, Vehicle } from '../../src/types';
import { useVehicleData } from '../../src/vehicleData';
import { useAppTheme } from '../../src/ThemeProvider';
import { useDemoMode } from '../../src/demo/DemoModeProvider';
import { resolveThemeAsset, type ThemeColors } from '../../src/themePacks';

/** 卡片错峰入场动画样式：opacity + 轻微上移。 */
const enterStyle = (a: Animated.Value): any => ({
  opacity: a,
  transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
});

/** Customize the formula freely — split is 5/12/14/18 windows for typical CN hrs. */
function greeting(name: string | undefined): string {
  const h = new Date().getHours();
  const part = h < 5 ? '晚上好' : h < 12 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  return name ? `${part}，${name}` : part;
}

/** 问候语下方的动态提示：异常 > 智能 > 天气（异常最重要，优先看到）。 */
type HomeTip = { text: string; icon: keyof typeof Ionicons.glyphMap; color: string; bg: string };

function pickTip(
  snap: Snapshot | null,
  relay: RelayStatus | null,
  weather: AmapWeather | null,
  cfg: { enabled: boolean; anomaly: boolean; smart: boolean; weatherOn: boolean; lowBattPct: number; tempWarnC: number; tempDangerC: number },
  c: ThemeColors,
): HomeTip | null {
  const r = (n: number | null | undefined) => (n == null ? null : Math.round(n));
  if (!cfg.enabled) return null;

  // —— 异常提示：温度分级阈值与低电量阈值均可配 ——
  if (cfg.anomaly) {
    const pbt = relay?.phone_battery_temp_c ?? null;
    if (pbt != null) {
      if (pbt >= cfg.tempDangerC) return { text: `中继手机温度达 ${r(pbt)}°C，严重过热，请立即断电检查散热`, icon: 'alert-circle', color: c.danger, bg: c.dangerSoft };
      if (pbt >= cfg.tempWarnC) return { text: `中继手机温度偏高（${r(pbt)}°C），建议检查散热`, icon: 'thermometer', color: c.warning, bg: c.warningSoft };
    }
    const bt = snap?.batt_temp ?? null;
    if (bt != null) {
      if (bt >= cfg.tempDangerC) return { text: `电池温度 ${r(bt)}°C，严重过热，请尽快降温`, icon: 'alert-circle', color: c.danger, bg: c.dangerSoft };
      if (bt >= cfg.tempWarnC) return { text: `电池温度偏高（${r(bt)}°C），注意散热`, icon: 'thermometer', color: c.warning, bg: c.warningSoft };
    }
    const soc = snap?.primary?.soc_pct ?? null;
    if (soc != null && soc <= cfg.lowBattPct) return { text: `电量仅 ${r(soc)}%，建议尽快充电`, icon: 'battery-dead-outline', color: c.danger, bg: c.dangerSoft };
  }

  // —— 智能提示：结合车辆/天气状态给出场景建议 ——
  if (cfg.smart) {
    if (weather) {
      const w0 = weather.casts[0];
      const w1 = weather.casts[1];
      const rain = (c?: AmapWeatherCast) => !!c && (c.dayWeather.includes('雨') || c.nightWeather.includes('雨'));
      if (rain(w0)) return { text: '今日有雨，出门记得带伞', icon: 'umbrella', color: c.primary, bg: c.primarySoft };
      if (w0 && !rain(w0) && w0.nightWeather.includes('雨')) return { text: '今夜有雨，停车注意防雨', icon: 'umbrella', color: c.primary, bg: c.primarySoft };
      if (rain(w1)) return { text: '明日有雨，提前做好防雨准备', icon: 'umbrella', color: c.primary, bg: c.primarySoft };
    }
    const soc = snap?.primary?.soc_pct ?? null;
    const charging = snap?.remain_charge_time != null && snap?.remain_charge_time !== '' && snap?.remain_charge_time !== 0;
    if (charging) {
      const rt = snap!.remain_charge_time;
      const rtTxt = typeof rt === 'number' ? `${rt} 分钟` : String(rt);
      return { text: `车辆充电中，预计 ${rtTxt} 后满`, icon: 'flash', color: c.primary, bg: c.primarySoft };
    }
    if (relay?.board_state === 'live') return { text: '中继与保护板实时同步中', icon: 'sync', color: c.primary, bg: c.primarySoft };
    if (relay?.board_state === 'connected_stale') return { text: `保护板仍已连接，最近数据 ${Math.max(1, Math.floor((relay.board_frame_age_seconds ?? 0) / 60))} 分钟前`, icon: 'time-outline', color: c.warning, bg: c.warningSoft };
    if (soc != null && soc >= 80) return { text: '电量充足，放心出行', icon: 'checkmark-circle', color: c.primary, bg: c.primarySoft };
  }

  // —— 天气提示（兜底问候）——
  if (cfg.weatherOn && weather && weather.today.dayWeather) {
    return { text: `${weather.city || '当地'}今日${weather.today.dayWeather} ${weather.today.dayTemp}°C`, icon: 'partly-sunny', color: c.textSecondary, bg: c.surfaceSecondary };
  }
  return null;
}

export default function HomeScreen() {
  const { unlocked } = useAuth();
  const router = useRouter();
  const { top } = useHeaderTheme(headerThemes.index);
  const rs = useResponsive();
  const { vehicles, selectedSn, snapshot: snap, relay, refreshAll } = useVehicleData();
  const { colors: tc, theme, resolvedMode, dialogueEnabled } = useAppTheme();
  const { isDemoMode } = useDemoMode();
  const heroCharacter = resolveThemeAsset(theme.pack, 'characterHero', resolvedMode);
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bellLoading, setBellLoading] = useState(false);
  // 按铃结果反馈：ok 短暂变绿 / fail 变红，1.6s 后回中性（原来成功失败都无提示）。
  const [bellState, setBellState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [now, setNow] = useState(() => Date.now());
  // 胎压：与车辆快照不同源（中继被动嗅探 → 服务端解码），失败静默降级，
  // 绝不阻塞首页主数据。传感器约 9~10 分钟心跳一次，故读数天然滞后于当下。
  const [tpms, setTpms] = useState<TpmsCurrent | null>(null);
  const [mapLoading, setMapLoading] = useState(true);
  // 首页问候语下方的动态提示（天气 / 智能 / 异常，按优先级取其一）。
  const [weather, setWeather] = useState<AmapWeather | null>(null);
  // 首页体验偏好（本地存储，运行时读取）
  const [homeSec, setHomeSec] = useState(300);
  const [tipEnabled, setTipEnabled] = useState(true);
  const [tipAnomaly, setTipAnomaly] = useState(true);
  const [tipSmart, setTipSmart] = useState(true);
  const [tipWeather, setTipWeather] = useState(true);
  const [lowBattPct, setLowBattPct] = useState(10);
  const [tempWarnC, setTempWarnC] = useState(40);
  const [tempDangerC, setTempDangerC] = useState(45);
  const [mapZoom, setMapZoom] = useState(15);

  // 读取首页体验偏好（本地存储）。
  useEffect(() => {
    (async () => {
      setHomeSec(await getHomeRefreshSec());
      const tp = await getTipPrefs();
      setTipEnabled(tp.enabled); setTipAnomaly(tp.anomaly); setTipSmart(tp.smart); setTipWeather(tp.weather);
      setLowBattPct(await getLowBatteryPct());
      setTempWarnC(await getTempWarnC());
      setTempDangerC(await getTempDangerC());
      setMapZoom(await getMapZoom());
    })();
  }, []);
  // M7: monotonic request sequence — a slow earlier load (e.g. for vehicle A)
  // must never overwrite state written by a newer one (vehicle B), or the
  // dashboard shows B's name with A's battery.
  const loadSeqRef = useRef(0);

  // —— 2026-08 紧凑 + 炫酷动效基础（全部内置 Animated，无新依赖）——
  // 卡片错峰入场：车辆数据首次到达时播放一次，避免空数据期误播。
  const cardAnims = useRef([0, 1, 2, 3].map(() => new Animated.Value(0))).current;
  const enteredRef = useRef(false);
  useEffect(() => {
    if (vehicles.length > 0 && !enteredRef.current) {
      enteredRef.current = true;
      Animated.stagger(70, cardAnims.map((a) =>
        Animated.timing(a, { toValue: 1, duration: 380, useNativeDriver: true, easing: Easing.out(Easing.ease) })
      )).start();
    }
  }, [vehicles.length]);

  // 充电徽章呼吸 + 在线点 ping 波纹
  const pulse = useRef(new Animated.Value(0)).current;
  const ping = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
    ])).start();
    Animated.loop(Animated.sequence([
      Animated.timing(ping, { toValue: 1, duration: 1500, useNativeDriver: true, easing: Easing.out(Easing.ease) }),
      Animated.timing(ping, { toValue: 0, duration: 0, useNativeDriver: true }),
    ])).start();
  }, []);

  // 地图骨架微光扫过
  const shimmer = useRef(new Animated.Value(-1)).current;
  useEffect(() => {
    Animated.loop(Animated.timing(shimmer, { toValue: 1, duration: 1200, useNativeDriver: true, easing: Easing.linear })).start();
  }, []);

  const load = useCallback(async (overrideSn?: string, isRefresh = false, silent = false) => {
    if (!unlocked) { setLoading(false); return; }
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;
    try {
      // M9: silent background polls never touch the spinners — the 60s
      // auto-refresh used to flash the pull-refresh spinner every minute.
      if (!silent) { if (isRefresh) setRefreshing(true); else setLoading(true); }
      setError(null);
      const [acct, shared] = await Promise.all([whoami(), refreshAll(overrideSn)]);
      if (!isCurrent()) return;
      setAccount(acct);
      const vcls = shared.vehicles;
      const sn = shared.sn;
      const freshSnap = shared.snapshot;
      if (sn && freshSnap) {
        // 天气：按车辆坐标查高德（复用后端 AMAP_KEY）。非阻塞、失败静默降级。
        const loc = freshSnap.location;
        if (loc?.latitude != null && loc?.longitude != null) {
          fetchWeather(loc.latitude, loc.longitude)
            .then((w) => { if (isCurrent()) setWeather(w); })
            .catch(() => {});
        }
        pushDashboardToWidget({
          battery: freshSnap.battery,
          // 电量环主口径优先保护板库仑 SoC，回退电压法；原生 widget 读 socVoltage。
          socVoltage: freshSnap.primary?.soc_pct,
          socSource: freshSnap.primary?.source ?? null,
          voltage: freshSnap.bms_voltage,
          temperature: freshSnap.batt_temp,
          range: freshSnap.primary?.range_km,
          charging: freshSnap.charging,
          vehicleName: vcls.find(v => v.sn === sn)?.name,
          healthScore: freshSnap.bms_score,
          locked: freshSnap.lock,
          remainChargeTime: freshSnap.remain_charge_time,
          calibratedRange: freshSnap.primary?.range_km,
          cycles: vcls.find(v => v.sn === sn)?.effective_cycle_count ?? freshSnap.bms_cycles,
          // Self-refresh credentials for the widget provider (app-dead path).
          serverUrl: await getBaseUrl(),
          apiKey: freshSnap.widget_token,
        });
      }
    } catch (e) { if (isCurrent()) setError(e instanceof Error ? e.message : '加载失败'); }
    finally { if (isCurrent()) { setLoading(false); setRefreshing(false); } }
  }, [unlocked, refreshAll]);

  // 胎压走独立轻量轮询，不能绑在首页整页刷新频率上。传感器本身约
  // 9~10 分钟心跳一次，但中继抓到并上传后，页面应在十几秒内显示，
  // 而不是再额外等待默认 5 分钟的首页刷新周期。
  const refreshTpms = useCallback(() => {
    if (!unlocked) return;
    fetchTpms().then(setTpms).catch(() => {});
  }, [unlocked]);

  useFocusEffect(useCallback(() => {
    load();
    // Poller writes a fresh snapshot every 5 min; refetch on the user's interval.
    const t = setInterval(() => load(undefined, false, true), Math.max(15, homeSec) * 1000);
    // Keeps the "数据更新于 X 分钟前" label honest between refetches.
    const clock = setInterval(() => setNow(Date.now()), 30000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [load, homeSec]));

  useFocusEffect(useCallback(() => {
    refreshTpms();
    const t = setInterval(refreshTpms, 15_000);
    return () => clearInterval(t);
  }, [refreshTpms]));

  const vehicle = vehicles.find(v => v.sn === selectedSn) ?? vehicles[0];
  // SOC 主口径统一 = 电压法（蜂巢 14S 高压 OCV 表，pack÷14串），放电/充电一致。
  // 车机 dump_energy 按原厂电池标定，在这块第三方包上系统性偏高 ~15pp，仅作对照展示。
  // 充电中端子电压会被充电流 I×R 轻微抬高 → 电压法略偏乐观（通常 <1pp，远小于
  // 车机的 +15pp），故充电时仍走电压法，保持口径唯一、随充电次数收敛。
  const vendorBatt = snap?.battery ?? null;
  // SOC 主口径优先级：保护板库仑 SoC（relay 实时，最优）→ 电压法 OCV → 车机。
  // 保护板 soc_pct 是 ∫I·dt 真实计量，单调不随负载跳变，比电压法准。
  const batt = snap?.primary?.soc_pct ?? null;
  // Kept only temporarily while existing localized strings are retired. The
  // canonical energy card above is the sole visible range presentation.
  const pct = batt !== null ? Math.round(batt) : null;

  const socColor = socRampColor(pct);
  const socText = socRampText(pct);
  // 问候语下方的动态提示（异常 > 智能 > 天气，取其一）。
  const tip = useMemo(
    () => pickTip(snap, relay, weather, { enabled: tipEnabled, anomaly: tipAnomaly, smart: tipSmart, weatherOn: tipWeather, lowBattPct, tempWarnC, tempDangerC }, tc),
    [snap, relay, weather, tipEnabled, tipAnomaly, tipSmart, tipWeather, lowBattPct, tempWarnC, tempDangerC, tc]
  );

  // SOC 数字在数值变化时弹一下（值刷新时有"跳动"的灵动感）
  const socScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (pct == null) return;
    socScale.setValue(1);
    Animated.sequence([
      Animated.timing(socScale, { toValue: 1.18, duration: 180, useNativeDriver: true, easing: Easing.out(Easing.ease) }),
      Animated.timing(socScale, { toValue: 1, duration: 260, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
    ]).start();
  }, [pct]);

  // 电压/温度颜色编码（14S 高压包：满电 ~60.5V，截止 ~42V）
  // 真实在线状态：快照时间 ≤10min 视为在线（与下方"数据更新于"判定同口径）。
  // 头部圆点此前常绿、不代表任何状态，现绑定到它：在线绿+呼吸，离线/未知灰。
  const vehicleOnline = (() => {
    const ts = snap?.timestamp ? new Date(snap.timestamp).getTime() : NaN;
    return Number.isFinite(ts) && (now - ts) <= 10 * 60 * 1000;
  })();

  const openMap = useCallback(() => {
    if (snap?.location) {
      const { latitude, longitude } = snap.location;
      const [gcjLng, gcjLat] = wgs84ToGcj02(longitude, latitude);
      // R9: openURL rejects when no handler exists — never let it float.
      void Linking.openURL(`https://uri.amap.com/marker?position=${gcjLng},${gcjLat}&name=${encodeURIComponent(snap.location.description ?? '车辆位置')}`).catch(() => {});
    }
  }, [snap?.location]);

  const handleBell = useCallback(async () => {
    const sn = selectedSn;
    if (!sn || bellLoading) return;
    if (isDemoMode) {
      Alert.alert('演示模式', '演示模式：不会执行真实车辆操作。');
      return;
    }
    setBellLoading(true);
    try {
      await sendCommand(sn, 'bell');
      setBellState('ok');
    } catch {
      setBellState('fail');
    } finally {
      setBellLoading(false);
      setTimeout(() => setBellState('idle'), 1600);
    }
  }, [bellLoading, isDemoMode, selectedSn]);

  // ④ 地图改用后端代理取高德静态图：服务器（白名单 IP + 持有 key）去高德
  //    拉 PNG 并流式返回，手机用带会话 cookie 的 fetch 取字节 → base64 → <Image>。
  //    这样绕开两坑：①高德 key 绑定服务器 IP，手机公网 IP 直连被拒；
  //    ②<Image> 不带会话 cookie，直连会被网关 401。
  const mapWidth = rs.width - rs.pagePad * 2;
  const mapHeight = Math.round(mapWidth * 0.6);
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (isDemoMode) {
      setMapUrl(null); setMapFailed(false); setMapLoading(false);
      return () => { cancelled = true; };
    }
    const lat = snap?.location?.latitude;
    const lng = snap?.location?.longitude;
    if (lat == null || lng == null) { setMapUrl(null); setMapFailed(false); setMapLoading(false); return; }
    setMapFailed(false);
    setMapLoading(true);
    const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);
    const w = Math.round(mapWidth);
    const h = mapHeight;
    (async () => {
      try {
        const base = await getBaseUrl();
        const u = `${base}/api/map/static?lng=${gcjLng}&lat=${gcjLat}&zoom=${mapZoom}&w=${w}&h=${h}&scale=2`;
        // 此前无超时：服务器挂起时地图区永远停在加载态。12s 足够代理往返高德。
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 12_000);
        let res: Response;
        try {
          res = await fetch(u, { credentials: 'include', signal: ctrl.signal });
        } finally {
          clearTimeout(timeout);
        }
        if (cancelled) return;
        if (!res.ok) { setMapFailed(true); setMapLoading(false); return; }
        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('image')) { setMapFailed(true); setMapLoading(false); return; }
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        setMapUrl(`data:image/png;base64,${bytesToBase64(new Uint8Array(buf))}`);
      } catch {
        if (!cancelled) { setMapFailed(true); setMapLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [isDemoMode, snap?.location?.latitude, snap?.location?.longitude, mapWidth, mapZoom]);

  return (
    <ScrollView style={[s.container, { backgroundColor: tc.background }]} contentContainerStyle={{ paddingHorizontal: rs.pagePad, paddingTop: top, paddingBottom: spacing.xxl }} refreshControl={<RefreshControl tintColor={tc.primary} refreshing={refreshing} onRefresh={() => load(undefined, true)} />}>
      {loading && !vehicle ? (
        <DashboardSkeleton />
      ) : error && !vehicle ? (
        <EmptyState
          variant="float"
          icon="alert-circle-outline"
          title="加载失败"
          subtitle={error}
          accent={tc.danger}
          accentBg={tc.dangerSoft}
          actionLabel="重试"
          onAction={() => load()}
        />
      ) : vehicles.length === 0 ? (
        <EmptyState
          variant="float"
          icon="bicycle-outline"
          title="暂无车辆"
          subtitle="请先在设置页绑定车辆"
          accent={tc.textSecondary}
          accentBg={tc.surfaceSecondary}
        />
      ) : (
        <>
        {error && (
          <View style={[s.errorCard, { backgroundColor: tc.dangerSoft, borderColor: tc.danger }]}>
            <Ionicons name="alert-circle-outline" size={30} color={tc.danger} style={{ marginBottom: spacing.sm }} />
            <AppText style={[s.errorText, { color: tc.danger }]}>{error}</AppText>
            <Pressable style={({ pressed }) => [s.retryBtn, { backgroundColor: tc.primary }, pressed && { opacity: 0.85 }]} onPress={() => load()}>
              <AppText style={[s.retryBtnText, { color: tc.onPrimary }]}>重试</AppText>
            </Pressable>
          </View>
        )}

        {account && (
          // 与下方车辆卡片统一的 Card 白底 —— 之前是无背景色的灰块，
          // 配白字头像在浅色主题下视觉突兀。
          <Animated.View style={enterStyle(cardAnims[0])}>
          <View style={s.accountCard}>
            <View style={s.accountRow}>
              <View style={s.avatar}>
                {account.avatar ? (
                  <Image source={{ uri: account.avatar }} style={s.avatarImg} resizeMode="cover" />
                ) : (
                  <AppText style={s.avatarText}>{account.username?.[0] ?? '?'}</AppText>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={[s.greeting, { color: tc.textPrimary }]}>{greeting(account.username)}</AppText>
                {tip && (
                  <View style={[s.tipRow, { backgroundColor: tip.bg }]}>
                    <Ionicons name={tip.icon} size={13} color={tip.color} />
                    <AppText style={[s.tipText, { color: tip.color }]} numberOfLines={1}>{tip.text}</AppText>
                  </View>
                )}
              </View>
              <View style={s.headerOnline}>
                <AppText style={[s.headerOnlineText, { color: vehicleOnline ? tc.textSecondary : tc.textMuted }]}>{vehicleOnline ? '在线' : '离线'}</AppText>
              <View style={s.onlineDotWrap}>
                {vehicleOnline && (
                  <Animated.View style={[s.onlinePing, { opacity: ping.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }), transform: [{ scale: ping.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }] } as any]} />
                )}
                <View style={[s.onlineDot, { backgroundColor: vehicleOnline ? tc.success : tc.textDim }]} />
              </View>
              </View>
            </View>
          </View>
        </Animated.View>
        )}

      {vehicles.length > 1 && (
        <View style={s.vehicleRow}>
          {vehicles.map(v => (
            <Pressable key={v.sn} onPress={() => { load(v.sn); }}
              style={({ pressed }) => [s.vehicleChip, { backgroundColor: selectedSn === v.sn ? tc.primary : tc.surface, borderColor: selectedSn === v.sn ? tc.primary : tc.border }, pressed && { opacity: 0.8 }]}>
              <AppText style={[s.vehicleChipText, { color: selectedSn === v.sn ? tc.onPrimary : tc.textSecondary }]}>{v.name}</AppText>
            </Pressable>
          ))}
        </View>
      )}

      {vehicle && (
        <Animated.View style={enterStyle(cardAnims[1])}>
        <Card variant="raised" style={s.vehicleCard}>
          <View pointerEvents="none" style={[s.heroGlow, { backgroundColor: tc.primary }]} />
          <View style={s.vehicleHeader}>
            <View style={{ flex: 1 }}>
              <AppText style={[s.vehicleName, { color: tc.textPrimary }]}>{vehicle.name}</AppText>
              <AppText style={[s.vehicleModel, { color: tc.textMuted }]}>
                {vehicle.color ? `${vehicle.color} · ` : ''}{vehicle.vehicle_name_zh ?? vehicle.model}
              </AppText>
            </View>
            <Pressable onPress={handleBell} disabled={bellLoading} hitSlop={10}
              style={({ pressed }) => [s.bellBtn, { backgroundColor: tc.surfaceSecondary }, pressed && { opacity: 0.7 }, bellLoading && { opacity: 0.5 }]}>
              <Ionicons
                name={bellLoading ? 'hourglass-outline' : bellState === 'ok' ? 'notifications' : 'notifications-outline'}
                size={19}
                color={bellState === 'ok' ? tc.success : bellState === 'fail' ? tc.danger : tc.textSecondary} />
            </Pressable>
          </View>

          <Pressable onPress={() => router.push('/(tabs)/battery')} style={({ pressed }) => [s.heroBody, pressed && { opacity: 0.86 }]}>
            <View style={s.heroEnergyRow}>
              <View style={s.heroEnergyMetric}>
                <AppText style={[s.heroMetricLabel, { color: tc.textMuted }]}>电量</AppText>
                <AppText maxFontSizeMultiplier={1.35} style={[s.heroMetricValue, { color: tc.textPrimary }]}>{pct == null ? '--' : `${pct}%`}</AppText>
                <View style={[s.energyCapsule, { backgroundColor: tc.surfaceSecondary, borderColor: tc.border }]}>
                  <View style={[s.energyCapsuleInner, { width: `${pct ?? 0}%`, backgroundColor: tc.primary }]} />
                  <View style={[s.energyCapsuleMark, { backgroundColor: tc.border }]} />
                </View>
              </View>
              <View style={[s.heroEnergyDivider, { backgroundColor: tc.borderSubtle }]} />
              <View style={s.heroEnergyMetric}>
                <AppText style={[s.heroMetricLabel, { color: tc.textMuted }]}>剩余续航</AppText>
                <View style={s.heroRangeRow}><AppText maxFontSizeMultiplier={1.35} style={[s.heroMetricValue, { color: tc.textPrimary }]}>{snap?.primary?.range_km == null ? '--' : snap.primary.range_km.toFixed(1)}</AppText><AppText style={[s.heroMetricUnit, { color: tc.textMuted }]}>km</AppText></View>
                <AppText style={[s.heroSource, { color: tc.textDim }]} numberOfLines={1}>{snap?.primary?.source === 'bms' ? '保护板实时数据' : snap?.primary?.source === 'voltage' ? '电压估算' : '车机参考'}</AppText>
              </View>
            </View>
            <View style={[s.heroVehicleStage, rs.sizeClass === 'compact' && s.heroVehicleStageCompact]}>
              <View style={[s.vehicleAura, { backgroundColor: tc.primary }]} />
              <View style={[s.vehicleAuraSecondary, { backgroundColor: tc.primary }]} />
              {heroCharacter ? <Image source={heroCharacter} resizeMode="contain" style={[s.heroCharacter, {
                width: `${Math.round(theme.pack.hero.characterScale * 34)}%`,
                transform: [{ translateX: theme.pack.hero.characterOffsetX }, { translateY: theme.pack.hero.characterOffsetY }],
                // The character is scenery behind the real vehicle. Keep its
                // pack-configured scale/offset, but make the vehicle the
                // authoritative foreground layer below the tire readouts.
                zIndex: 0,
              }, rs.sizeClass === 'compact' && s.heroCharacterCompact]} /> : null}
              <HeroTireReadout wheel={tpms?.front ?? null} label="前轮" nominal={TPMS_NOMINAL.front} side="left" compact={rs.sizeClass === 'compact'} />
              <View style={s.heroVehicleImageSlot}>
                {(vehicle.custom_image_url ?? vehicle.image_url) ? <Image source={{ uri: (vehicle.custom_image_url ?? vehicle.image_url)! }} style={[s.heroVehicleImage, { transform: [{ translateX: (rs.sizeClass === 'compact' ? 0 : 5) + theme.pack.hero.vehicleOffsetX }, { translateY: theme.pack.hero.vehicleOffsetY }], width: `${Math.round(115 * theme.pack.hero.vehicleScale)}%` }]} resizeMode="contain" /> : <Ionicons name="bicycle-outline" size={86} color={tc.textDim} />}
              </View>
              <HeroTireReadout wheel={tpms?.rear ?? null} label="后轮" nominal={TPMS_NOMINAL.rear} side="right" compact={rs.sizeClass === 'compact'} />
              {dialogueEnabled && theme.pack.dialogue?.home?.[0] ? (
                <View pointerEvents="none" style={s.dialogueBubbleWrap}>
                  <View style={[s.dialogueBubble, { backgroundColor: tc.surface, borderColor: tc.border }]}>
                    <AppText numberOfLines={2} style={[s.dialogueBubbleText, { color: tc.textSecondary }]}>
                      {snap?.charging && theme.pack.dialogue.charging?.[0] ? theme.pack.dialogue.charging[0] : theme.pack.dialogue.home[0]}
                    </AppText>
                  </View>
                  <View style={[s.dialogueTail, { backgroundColor: tc.surface, borderRightColor: tc.border, borderBottomColor: tc.border }]} />
                </View>
              ) : null}
            </View>
          </Pressable>

          <HeroTpmsWarning tpms={tpms} />

          <View style={[s.heroFooter, { borderTopColor: tc.borderSubtle }]}>
            <View style={s.heroStateItem}><Ionicons name={snap?.lock === 1 ? 'lock-closed-outline' : 'lock-open-outline'} size={15} color={snap?.lock === 1 ? tc.textSecondary : tc.warning} /><AppText style={[s.heroStateText, { color: snap?.lock === 1 ? tc.textSecondary : tc.warning }]}>{snap?.lock === 1 ? '已锁定' : '未锁车'}</AppText></View>
            {vehicle.total_mileage_km != null && <Pressable onPress={() => router.push('/(tabs)/rides')} style={s.heroMileage}><AppText style={[s.heroMileageLabel, { color: tc.textMuted }]}>总里程</AppText><AppText style={[s.heroMileageValue, { color: tc.textPrimary }]}>{Math.round(vehicle.total_mileage_km).toLocaleString()} km</AppText><Ionicons name="chevron-forward" size={14} color={tc.textDim} /></Pressable>}
          </View>
          {snap?.charging && <Animated.View style={[s.heroChargeBanner, { backgroundColor: tc.warningSoft, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }) }]}><Ionicons name="flash" size={15} color={tc.warning} /><AppText style={[s.heroChargeText, { color: tc.warning }]}>正在充电{snap.charging_power != null ? ` · ${Math.round(snap.charging_power)} W` : ''}{fmtRemainChargeTime(snap.remain_charge_time) ? ` · 约 ${fmtRemainChargeTime(snap.remain_charge_time)}` : ''}</AppText></Animated.View>}

          {/* M14: data-age hint — Snapshot.timestamp always existed but was
              never rendered, so an offline vehicle looked "live" with
              30-minute-old data. */}
          {snap?.timestamp != null && (() => {
            const ts = new Date(snap.timestamp).getTime();
            if (!Number.isFinite(ts)) return null; // malformed timestamp — hide the hint entirely
            const ageMs = Math.max(0, now - ts);
            const stale = ageMs > 10 * 60 * 1000; // poller cadence is 5 min
            return (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <AppText style={[s.dataAge, { color: stale ? tc.warning : tc.textMuted }, stale && s.dataAgeStale]}>
                  数据更新于 {fmtAge(ageMs)}{stale ? ' · 数据可能过期' : ''}
                </AppText>
                <InfoHint hintKey="vehicle_online" size={12} />
              </View>
            );
          })()}

        </Card>
        </Animated.View>
      )}

      <Animated.View style={enterStyle(cardAnims[2])}>
      <RelayStatusCard relay={relay} tempWarnC={tempWarnC} tempDangerC={tempDangerC} />
      </Animated.View>

      {snap?.location?.latitude != null && (
        <Animated.View style={enterStyle(cardAnims[3])}>
        <Card pad={false} style={s.mapCard}>
          <Pressable onPress={openMap} style={({ pressed }) => pressed && { opacity: 0.7 }}>
            <View style={s.locationHeader}>
              <Ionicons name="location-outline" size={16} color={tc.primary} />
              <AppText style={[s.locationLabel, { color: tc.textSecondary }]} numberOfLines={1}>{snap.location.description ?? '位置信息'}</AppText>
              <AppText style={[s.locationOpen, { color: tc.primary }]}>打开地图 ›</AppText>
            </View>
          </Pressable>
          <View style={[s.mapWrap, { height: mapHeight }]}>
            {isDemoMode ? (
              <View style={[s.mapSkeleton, { backgroundColor: tc.surfaceSecondary }]}>
                <Ionicons name="map-outline" size={30} color={tc.primary} />
                <AppText style={[s.mapSkeletonText, { color: tc.textSecondary }]}>北京市东城区 · 演示位置</AppText>
              </View>
            ) : mapFailed ? (
              <View style={[s.mapSkeleton, { backgroundColor: tc.surfaceSecondary }]}>
                <Ionicons name="cloud-offline-outline" size={30} color={tc.textMuted} />
                <AppText style={[s.mapSkeletonText, { color: tc.textMuted }]}>地图暂不可用</AppText>
              </View>
            ) : mapUrl ? (
              <Image
                source={{ uri: mapUrl }}
                style={[s.mapWebView, { height: mapHeight, width: '100%' }]}
                resizeMode="cover"
                onLoad={() => setMapLoading(false)}
                onError={() => { setMapFailed(true); setMapLoading(false); }}
              />
            ) : null}
            {mapLoading && !mapFailed && (
              <View style={[s.mapSkeleton, { backgroundColor: tc.surfaceSecondary }]}>
                <Animated.View style={[s.shimmerBar, { transform: [{ translateX: shimmer.interpolate({ inputRange: [-1, 1], outputRange: [-140, mapWidth + 140] }) }, { skewX: '18deg' }] } as any]}>
                  <LinearGradient from="rgba(255,255,255,0)" to="rgba(255,255,255,0.75)" steps={6} diagonal style={{ width: '100%', height: '100%' }} />
                </Animated.View>
                <Ionicons name="map-outline" size={30} color={tc.textMuted} />
                <AppText style={[s.mapSkeletonText, { color: tc.textMuted }]}>地图加载中…</AppText>
              </View>
            )}
          </View>
        </Card>
        </Animated.View>
      )}
        </>
      )}
    </ScrollView>
  );
}

function RelayStatusCard({ relay, tempWarnC, tempDangerC }: { relay: RelayStatus | null; tempWarnC: number; tempDangerC: number }) {
  // Hooks must run unconditionally — moving this above the early return fixes a
  // "Rendered more hooks than during the previous render" crash when relay
  // transitions from null to a value.
  const rs = useResponsive();
  const router = useRouter();
  const { colors: c } = useAppTheme();
  if (!relay) return null;
  const charging = relay.phone_charging === true;
  const connected = relay.connected;

  // 连接状态：present=false → 中继从未上报；connected=false → 5 分钟内无数据（离线）；
  // board_connected → 最新一行带真实 BMS 帧（蚂蚁板已连接）。
  const connLabel = !relay.present
    ? '未启用'
    : connected
      ? (relay.board_state === 'live' ? '板实时' : relay.board_state === 'connected_stale' ? '板已连·待同步' : '在线')
      : '离线';
  const connPill = !relay.present
    ? { fg: c.textMuted, bg: c.surfaceSecondary, icon: 'ellipse-outline' as const }
    : connected
      ? { fg: c.textSecondary, bg: c.surfaceSecondary, icon: 'wifi' as const }
      : { fg: c.danger, bg: c.dangerSoft, icon: 'wifi-outline' as const };

  return (
    <Card style={s.relayCard}>
      <Pressable style={s.relayHeader} onPress={() => router.push('/relay')}>
        <View style={s.relayTitleWrap}>
          <Ionicons name="phone-portrait-outline" size={18} color={c.primary} />
          <View><AppText style={[s.relayTitle, { color: c.textPrimary }]}>中继设备</AppText><AppText style={[s.relayDeviceName, { color: c.textMuted }]}>S7 edge</AppText></View>
        </View>
        <View style={s.relayPills}>
          {charging && <AppText style={[s.relayPowerHint, { color: c.textMuted }]}>供电中</AppText>}
          {connected && relay.board_state === 'live' ? <View style={s.relayQuietStatus}><View style={[s.relayQuietDot, { backgroundColor: c.success }]} /><AppText style={[s.relayQuietText, { color: c.success }]}>实时</AppText></View> : <StatusPill label={connLabel} icon={connPill.icon} fg={connPill.fg} bg={connPill.bg} />}
          <Ionicons name="chevron-forward" size={18} color={c.textDim} />
        </View>
      </Pressable>

      <View style={[s.relayDivider, { backgroundColor: c.borderSubtle }]} />

      <View style={s.relayMetrics}>
        <View style={s.relayMetric}><AppText style={[s.relayBatteryValue, { color: c.textPrimary }]}>{relay.phone_battery_level_pct == null ? '--' : `${Math.round(relay.phone_battery_level_pct)}%`}</AppText><AppText style={[s.relayMetricLabel, { color: c.textMuted }]}>设备电量</AppText></View>
        <View style={s.relayMetric}><AppText style={[s.relayMetricValue, { color: c.textSecondary }, relay.phone_battery_temp_c != null && relay.phone_battery_temp_c >= tempWarnC && { color: relay.phone_battery_temp_c >= tempDangerC ? c.danger : c.warning }]}>{relay.phone_battery_temp_c == null ? '--' : `${relay.phone_battery_temp_c.toFixed(1)}°C`}</AppText><AppText style={[s.relayMetricLabel, { color: c.textMuted }]}>手机温度</AppText></View>
        <View style={s.relayMetric}><AppText style={[s.relayMetricValue, { color: c.textSecondary }]}>{charging ? '供电中' : '未供电'}</AppText><AppText style={[s.relayMetricLabel, { color: c.textMuted }]}>供电状态</AppText></View>
      </View>

      {/* 环境温湿度（米家温湿度计，pvvx 广播 → 中继被动扫描）。
          与手机温度/电池温度是三个独立量，这里只讲车库环境。 */}
      {relay.ambient != null && (relay.ambient.temp_c != null || relay.ambient.humidity_pct != null) && (
        <View style={[s.relayAmbientRow, { backgroundColor: c.surfaceSecondary }, !relay.ambient.fresh && { opacity: 0.7 }]}>
          <Ionicons
            name="thermometer-outline"
            size={13}
            color={relay.ambient.fresh ? c.info : c.textMuted}
          />
          <AppText style={[s.relayAmbientText, { color: relay.ambient.fresh ? c.textSecondary : c.textMuted }]}>
            环境 {relay.ambient.temp_c != null ? `${relay.ambient.temp_c.toFixed(1)}°C` : '--'}
            {relay.ambient.humidity_pct != null ? ` · ${relay.ambient.humidity_pct.toFixed(0)}%RH` : ''}
            {relay.ambient.sensor_battery_mv != null ? ` · 计 ${(relay.ambient.sensor_battery_mv / 1000).toFixed(2)}V` : ''}
            {!relay.ambient.fresh ? ` · ${fmtAge((relay.ambient.age_seconds ?? 0) * 1000)}` : ''}
          </AppText>
        </View>
      )}

      <AppText style={[s.relayFooter, { color: c.textMuted }, !connected && relay.present && { color: c.danger }]}>
        {!relay.present
          ? '尚未收到中继上报（请先在 bms-relay 填入本车 SN 并启动）'
          : connected
            ? `最后上报 ${fmtAge((relay.age_seconds ?? 0) * 1000)}`
            : `中继离线 · 最后上报 ${fmtAge((relay.age_seconds ?? 0) * 1000)}`}
      </AppText>
    </Card>
  );
}

/** Uint8Array → base64（Hermes 无 btoa，手写保证可用）。 */
function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return out;
}

/** M14 helper: compact "x 分钟前" label for the data-age hint. */
function fmtAge(ageMs: number): string {
  if (ageMs < 60000) return '刚刚';
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)} 分钟前`;
  if (ageMs < 86400000) return `${Math.floor(ageMs / 3600000)} 小时前`;
  return `${Math.floor(ageMs / 86400000)} 天前`;
}

/** Canonical backend estimate is numeric minutes. String support remains only
 *  for one-release backward compatibility with older servers. */
function fmtRemainChargeTime(v: number | string | null | undefined): string | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return typeof v === 'string' ? v : null;
  if (n >= 60) return `${Math.floor(n / 60)} 小时 ${Math.round(n % 60)} 分钟`;
  return `${Math.round(n)} 分钟`;
}

function EnduranceBox({ value, unit, label, highlight, hintKey }: { value: number | null; unit: string; label: string; highlight?: boolean; hintKey?: HintKey }) {
  return (
    <View style={[s.enduranceBox, highlight && s.enduranceBoxHighlight]}>
      <View style={s.enduranceHead}>
        <AppText style={[s.enduranceLabel, highlight && s.enduranceValueHighlight]}>{label}</AppText>
        {hintKey ? <InfoHint hintKey={hintKey} size={12} /> : null}
      </View>
      <AppText style={[s.enduranceValue, highlight && s.enduranceValueHighlight]}>
        {value != null ? `${value}${unit}` : '—'}
      </AppText>
    </View>
  );
}

// —— 胎压（TPMS）——
// 安全范围（bar）：<1.8 过低、>3.0 过高、偏离标称 >0.4 提醒，否则正常。
const TPMS_NOMINAL = { front: 2.1, rear: 2.2 } as const;
const TPMS_LOW = 1.8;
const TPMS_HIGH = 3.0;
const TPMS_DEV = 0.4;
/** 超过这个时长仍无新帧就标灰：传感器心跳约 9~10 分钟，30 分钟没动静说明链路有问题。 */
const TPMS_STALE_SEC = 30 * 60;

type TireState = 'ok' | 'low' | 'high' | 'dev' | 'none';

function tireState(p: number | null, nominal: number): TireState {
  if (p === null) return 'none';
  if (p < TPMS_LOW) return 'low';
  if (p > TPMS_HIGH) return 'high';
  if (Math.abs(p - nominal) > TPMS_DEV) return 'dev';
  return 'ok';
}

/** Hero wheel readout. It owns a fixed side rail, so system text scaling cannot overlap the vehicle image. */
function HeroTireReadout({ wheel, label, nominal, side, compact }: { wheel: TpmsWheel | null; label: string; nominal: number; side: 'left' | 'right'; compact: boolean }) {
  const { colors: c } = useAppTheme();
  const p = wheel?.pressure ?? null;
  const t = wheel?.temp_c ?? null;
  const age = wheel?.age_seconds ?? null;
  const st = tireState(p, nominal);
  const stale = age !== null && age > TPMS_STALE_SEC;

  // 数据过期时压力值不再用"安全色"渲染，避免旧值伪装成实时状态。
  const accent = stale ? c.textMuted : st === 'ok' ? c.textPrimary : (st === 'low' || st === 'high') ? c.danger : st === 'dev' ? c.warning : c.textMuted;
  const abnormal = !stale && st !== 'ok' && st !== 'none';

  return (
    <View style={[s.heroTireReadout, compact && s.heroTireReadoutCompact, side === 'right' && s.heroTireReadoutRight]}>
        <View style={[s.heroTireLabelRow, side === 'right' && { justifyContent: 'flex-end' }]}>
          {abnormal && <Ionicons name="warning-outline" size={11} color={accent} />}
          <AppText style={[s.tireLabel, { color: abnormal ? accent : c.textMuted }]}>{label}</AppText>
        </View>
        <View style={s.tireValRow}>
          <AppText maxFontSizeMultiplier={1.25} numberOfLines={1} adjustsFontSizeToFit style={[s.tireVal, compact && s.tireValCompact, { color: accent }]}>{p === null ? '--' : p.toFixed(2)}</AppText>
          <AppText maxFontSizeMultiplier={1.15} style={[s.tireUnit, { color: c.textMuted }]}>bar</AppText>
        </View>
        <AppText maxFontSizeMultiplier={1.2} style={[s.tireMeta, { color: abnormal ? accent : c.textSecondary }]} numberOfLines={1}>
          {t === null ? '胎温 —' : `${t}°C`}
        </AppText>
    </View>
  );
}

function HeroTpmsWarning({ tpms }: { tpms: TpmsCurrent | null }) {
  const { colors: c } = useAppTheme();
  const front = tpms?.front ?? null;
  const rear = tpms?.rear ?? null;
  const fSt = tireState(front?.pressure ?? null, TPMS_NOMINAL.front);
  const rSt = tireState(rear?.pressure ?? null, TPMS_NOMINAL.rear);
  const frontAlert = fSt === 'low' || fSt === 'high' || fSt === 'dev';
  const rearAlert = rSt === 'low' || rSt === 'high' || rSt === 'dev';
  if (!frontAlert && !rearAlert) return null;
  const danger = fSt === 'low' || fSt === 'high' || rSt === 'low' || rSt === 'high';
  const wheel = frontAlert ? front : rear;
  const label = frontAlert ? '前轮' : '后轮';
  const color = danger ? c.danger : c.warning;
  return <View style={[s.heroTpmsWarning, { backgroundColor: danger ? c.dangerSoft : c.warningSoft }]}><Ionicons name="warning-outline" size={14} color={color} /><AppText style={[s.heroTpmsWarningText, { color }]}>{label} {wheel?.pressure?.toFixed(2) ?? '--'} bar{frontAlert && rearAlert ? ' · 前后轮均需检查' : ''}</AppText></View>;
}

/** 首载骨架屏：镜像仪表板的卡片布局，让界面"就地成型"而非闪一下转圈。 */
function DashboardSkeleton() {
  const shimmer = useShimmer();
  return (
    <View>
      <Card style={s.accountCard}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <Skeleton value={shimmer} width={48} height={48} round={24} />
          <Skeleton value={shimmer} width={150} height={16} round={radius.sm} />
        </View>
      </Card>

      <Card style={s.vehicleCard}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View style={{ flex: 1, gap: spacing.xs }}><Skeleton value={shimmer} width={'55%'} height={16} round={radius.sm} /><Skeleton value={shimmer} width={'35%'} height={12} round={radius.sm} /></View>
          <Skeleton value={shimmer} width={62} height={24} round={radius.full} />
        </View>
        <View style={{ flexDirection: 'row', gap: spacing.lg, marginTop: spacing.lg }}>
          <View style={{ flex: 1, gap: spacing.sm }}><Skeleton value={shimmer} width={90} height={32} round={radius.sm} /><Skeleton value={shimmer} height={14} round={radius.full} /></View>
          <View style={{ flex: 1, gap: spacing.sm }}><Skeleton value={shimmer} width={100} height={32} round={radius.sm} /><Skeleton value={shimmer} width={70} height={10} round={radius.sm} /></View>
        </View>
        <Skeleton value={shimmer} height={116} round={radius.xl} style={{ marginTop: spacing.md }} />
        <View style={[s.divider, { marginVertical: spacing.md }]} /><Skeleton value={shimmer} height={16} round={radius.sm} />
      </Card>

      <Card style={s.relayCard}>
        <Skeleton value={shimmer} width={120} height={16} round={radius.sm} style={{ marginBottom: spacing.md }} />
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Skeleton value={shimmer} style={{ flex: 1 }} height={56} round={radius.lg} />
          <Skeleton value={shimmer} style={{ flex: 1 }} height={56} round={radius.lg} />
          <Skeleton value={shimmer} style={{ flex: 1 }} height={56} round={radius.lg} />
        </View>
      </Card>

      <Card pad={false} style={s.mapCard}>
        <Skeleton value={shimmer} height={180} round={radius.lg} />
      </Card>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  errorCard: { marginBottom: spacing.sm, backgroundColor: colors.dangerLight, borderRadius: radius.lg, padding: spacing.lg, alignItems: 'center', ...shadow.subtle, borderWidth: 1, borderColor: tint.dangerBorder },
  errorText: { fontSize: fontSize.sm, color: tint.onDanger, textAlign: 'center', marginBottom: spacing.md },
  retryBtn: { backgroundColor: colors.primary, paddingVertical: 10, paddingHorizontal: 24, borderRadius: radius.md, ...shadow.subtle as any },
  retryBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '600' },

  accountCard: { marginBottom: spacing.md, paddingHorizontal: 2, paddingVertical: spacing.sm },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  avatarImg: { width: 42, height: 42 },
  avatarText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '700' },
  greeting: { fontSize: fontSize.xl, color: colors.text, fontWeight: '800', letterSpacing: 0.3 },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 7,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.md,
    maxWidth: '100%',
  },
  tipText: { fontSize: fontSize.xs, fontWeight: '600', flexShrink: 1 },
  accountPhone: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2, fontFamily: fontMono },
  onlineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.success, ...shadow.subtle as any },
  headerOnline: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  headerOnlineText: { fontSize: fontSize.xs, fontWeight: '700' },

  vehicleRow: { flexDirection: 'row', gap: spacing.sm, paddingBottom: spacing.sm, flexWrap: 'wrap' },
  vehicleChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.lg, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  vehicleChipActive: { backgroundColor: colors.text, borderColor: colors.text },
  vehicleChipText: { fontSize: fontSize.sm, color: colors.textSecondary },
  vehicleChipTextActive: { color: '#fff' },

  vehicleCard: { marginBottom: spacing.md, padding: spacing.lg, overflow: 'hidden' },
  heroGlow: { position: 'absolute', width: 250, height: 180, borderRadius: 125, opacity: 0.10, right: -80, top: -100 },
  vehicleHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  vehicleName: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text },
  vehicleModel: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  bellBtn: { width: 34, height: 34, borderRadius: 17, justifyContent: 'center', alignItems: 'center' },
  heroBody: { marginTop: spacing.lg },
  heroEnergyRow: { flexDirection: 'row', alignItems: 'stretch' },
  heroEnergyMetric: { flex: 1, minWidth: 0 },
  heroEnergyDivider: { width: 1, marginHorizontal: spacing.lg },
  heroMetricLabel: { fontSize: fontSize.sm, fontWeight: '600' },
  heroMetricValue: { fontSize: 36, fontWeight: '800', fontFamily: fontMono, letterSpacing: -1.6, marginTop: 2 },
  heroMetricUnit: { fontSize: fontSize.md, fontWeight: '600', marginLeft: 4 },
  heroRangeRow: { flexDirection: 'row', alignItems: 'baseline' },
  heroSource: { fontSize: fontSize.xs, marginTop: 5 },
  energyCapsule: { height: 16, padding: 2, paddingRight: 7, borderRadius: 8, borderWidth: 1, marginTop: 7, overflow: 'visible' },
  energyCapsuleInner: { height: 10, borderRadius: 5, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.32)' },
  energyCapsuleMark: { position: 'absolute', width: 3, height: 7, borderRadius: 2, right: 2, top: 3 },
  heroVehicleStage: { height: 148, flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, position: 'relative' },
  heroVehicleStageCompact: { height: 137 },
  vehicleAura: { position: 'absolute', width: 198, height: 76, borderRadius: 82, opacity: 0.09, left: '29%', bottom: 18, transform: [{ rotate: '-9deg' }] },
  vehicleAuraSecondary: { position: 'absolute', width: 108, height: 48, borderRadius: 54, opacity: 0.045, left: '43%', top: 24, transform: [{ rotate: '13deg' }] },
  heroVehicleImageSlot: { flex: 1, minWidth: 0, height: 142, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  heroVehicleImage: { width: '115%', height: 145 },
  heroCharacter: { position: 'absolute', height: '118%', right: 68, bottom: -10, opacity: 0.98 },
  heroCharacterCompact: { right: 57, height: '104%', bottom: -7, opacity: 0.96 },
  heroTireReadout: { width: 72, zIndex: 3, alignSelf: 'flex-end', marginBottom: 18 },
  heroTireReadoutCompact: { width: 62 },
  heroTireReadoutRight: { alignItems: 'flex-end' },
  heroTireLabelRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 3 },
  heroTpmsWarning: { marginTop: 2, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroTpmsWarningText: { flex: 1, fontSize: fontSize.xs, fontWeight: '700' },
  heroFooter: { borderTopWidth: 1, paddingTop: spacing.md, flexDirection: 'row', alignItems: 'center' },
  heroStateItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  heroStateText: { fontSize: fontSize.xs, fontWeight: '600' },
  heroStateSeparator: { marginHorizontal: 7 },
  heroMileage: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 },
  heroMileageLabel: { fontSize: fontSize.xs },
  heroMileageValue: { fontSize: fontSize.sm, fontWeight: '800', fontFamily: fontMono },
  heroChargeBanner: { marginTop: spacing.md, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  heroChargeText: { fontSize: fontSize.xs, fontWeight: '700' },
  dialogueBubbleWrap: { position: 'absolute', right: 86, top: -9, maxWidth: 124, zIndex: 8, alignItems: 'flex-end' },
  dialogueBubble: { maxWidth: 124, borderWidth: 1, borderRadius: 11, paddingHorizontal: 8, paddingVertical: 5, shadowOpacity: 0.08, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } },
  dialogueBubbleText: { fontSize: 10, lineHeight: 13, fontWeight: '600' },
  dialogueTail: { width: 8, height: 8, marginRight: 10, marginTop: -4, transform: [{ rotate: '45deg' }], borderRightWidth: 1, borderBottomWidth: 1 },

  batterySection: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  batteryRingWrap: { alignItems: 'center' },
  vendorSocHint: { fontSize: 10, color: colors.textMuted, marginTop: 4, fontFamily: fontMono },
  batteryPct: { fontWeight: '800', fontFamily: fontMono },
  batteryParams: { flex: 1 },

  odoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm, backgroundColor: colors.cardAlt, borderRadius: radius.lg, paddingVertical: 10, paddingHorizontal: spacing.md },
  odoLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  odoLabel: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600' },
  odoValue: { fontSize: fontSize.lg, fontWeight: '800', color: colors.text, fontFamily: fontMono },
  odoUnit: { fontSize: fontSize.xs, fontWeight: '400', color: colors.textMuted },

  divider: { height: 1, backgroundColor: colors.borderLight, marginVertical: spacing.sm },

  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'flex-start' },
  dataAge: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
  dataAgeStale: { color: colors.warning, fontWeight: '600' },

  tireLabel: { fontSize: fontSize.xs, color: colors.textMuted },
  tireValRow: { flexDirection: 'row', alignItems: 'baseline', gap: 3, marginTop: 2 },
  tireVal: { fontSize: fontSize.lg, fontWeight: '800', fontFamily: fontMono },
  tireValCompact: { fontSize: fontSize.md },
  tireUnit: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  tireMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  enduranceTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: spacing.sm, letterSpacing: 0.2 },
  enduranceSection: {},
  enduranceGrid: { flexDirection: 'row' },
  enduranceBox: { flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  enduranceBoxHighlight: { backgroundColor: colors.primaryLight },
  enduranceHead: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  enduranceValue: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text, fontFamily: fontMono, marginTop: 4 },
  enduranceValueHighlight: { color: colors.primary },
  enduranceLabel: { fontSize: fontSize.xs, color: colors.textMuted },

  chargeTimeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  chargeTime: { fontSize: fontSize.sm, color: tint.onWarning },

  mapCard: { marginBottom: spacing.sm, padding: spacing.lg, overflow: 'hidden' },
  locationHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  locationLabel: { flex: 1, fontSize: fontSize.sm, color: colors.textSecondary },
  locationOpen: { fontSize: fontSize.sm, color: colors.primary, fontWeight: '600' },
  mapWebView: { borderRadius: radius.lg, overflow: 'hidden' },
  mapWrap: { position: 'relative', borderRadius: radius.lg, overflow: 'hidden' },
  mapSkeleton: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardAlt, gap: spacing.xs, overflow: 'hidden' },
  mapSkeletonText: { fontSize: fontSize.xs, color: colors.textMuted },
  onlineDotWrap: { position: 'relative', width: 10, height: 10 },
  onlinePing: { position: 'absolute', top: 0, left: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.success },
  shimmerBar: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 90, overflow: 'hidden' },
  relayCard: { marginBottom: spacing.sm, padding: spacing.md },
  relayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  relayTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  relayTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  relayDeviceName: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  relayPills: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  relayPowerHint: { fontSize: fontSize.xs },
  relayQuietStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4 },
  relayQuietDot: { width: 5, height: 5, borderRadius: 3 },
  relayQuietText: { fontSize: fontSize.xs, fontWeight: '600' },
  relayDivider: { height: 1, backgroundColor: colors.borderLight, marginBottom: spacing.md },
  relayMetrics: { flexDirection: 'row', marginHorizontal: -spacing.xs, marginBottom: spacing.sm },
  relayMetric: { flex: 1, paddingHorizontal: spacing.xs, alignItems: 'center' },
  relayMetricValue: { fontSize: fontSize.md, fontWeight: '800', color: colors.text, fontFamily: fontMono },
  relayBatteryValue: { fontSize: fontSize.xl, fontWeight: '800', fontFamily: fontMono },
  relayMetricLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3 },
  relayFooter: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', marginTop: spacing.md },
  relayFooterWarn: { color: colors.warning, fontWeight: '600' },
  relayBoardRow: { flexDirection: 'row', alignItems: 'center', gap: 5, justifyContent: 'center', marginTop: spacing.sm, backgroundColor: colors.successLight, borderRadius: radius.md, paddingVertical: 6 },
  relayBoardText: { fontSize: fontSize.xs, color: tint.onSuccess, fontWeight: '600', fontFamily: fontMono },
  relayAmbientRow: { flexDirection: 'row', alignItems: 'center', gap: 5, justifyContent: 'center', marginTop: spacing.sm, backgroundColor: colors.infoLight, borderRadius: radius.md, paddingVertical: 6 },
  relayAmbientStale: { backgroundColor: colors.cardAlt },
  relayAmbientText: { fontSize: fontSize.xs, color: '#1e40af', fontWeight: '600', fontFamily: fontMono },
  relayAmbientTextStale: { color: colors.textMuted },
});
