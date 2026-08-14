import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Easing, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppText } from '../../src/components/AppText';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useIsFocused } from 'expo-router';
import * as Location from 'expo-location';
import { useAntBmsBluetooth, type ScannedDevice, type BmsFrame } from '../../src/useAntBmsBluetooth';
import { postBmsSnapshot } from '../../src/api';
import { getGpsSpeedEnabled, setGpsSpeedEnabled } from '../../src/widgetData';
import { useVehicleData } from '../../src/vehicleData';
import { EmptyState } from '../../src/components/EmptyState';
import { Card } from '../../src/components/Card';
import { Grid } from '../../src/components/Grid';
import { SectionHeader } from '../../src/components/SectionHeader';
import { ProgressRing, socRampColor } from '../../src/components/ProgressRing';
import { MetricTile } from '../../src/components/MetricTile';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import { useHeaderTheme } from '../../src/hooks/useHeaderTheme';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useStagger, enterStyle } from '../../src/hooks/useStagger';
import { FadeIn, PressScale } from '../../src/components/Motion';
import { colors, fontMono, fontSize, headerThemes, radius, shadow, spacing, tint } from '../../src/theme';
import { startGnssStatus, stopGnssStatus, addGnssListener, type GnssStatusData } from '../../src/gnssStatus';
import { useAppTheme } from '../../src/ThemeProvider';
import { resolveThemeAsset } from '../../src/themePacks';
import { useDemoMode } from '../../src/demo/DemoModeProvider';
import { getDemoBms, getDemoMotion } from '../../src/demo/demoData';

const UPLOAD_THROTTLE_MS = 5000;
// GPS 速度环满刻度（km/h）。九号踏板车封顶 ~25，50 留足余量。
const SPEED_MAX_KMH = 50;

// GNSS 星座展示顺序与配色（仅渲染数量 > 0 的）。expo-location 不暴露这些，
// 由原生 GnssStatusModule 桥接 Android GnssStatus 提供。
const CONSTELLATIONS: { key: keyof GnssStatusData['constellations']; label: string; fg: string; bg: string }[] = [
  { key: 'BEIDOU',  label: '北斗',   fg: colors.danger,      bg: colors.dangerLight },
  { key: 'GPS',     label: 'GPS',    fg: colors.primary,     bg: colors.primaryLight },
  { key: 'GLONASS', label: '格洛纳斯', fg: '#0f766e',        bg: '#ccfbf1' },
  { key: 'GALILEO', label: '伽利略', fg: colors.accentIndigo, bg: '#eef2ff' },
  { key: 'QZSS',    label: 'QZSS',   fg: colors.textMuted,   bg: colors.cardAlt },
  { key: 'IRNSS',   label: 'IRNSS',  fg: colors.textMuted,   bg: colors.cardAlt },
];

/** 信号等级 → 颜色（绿=强，黄/琥珀=弱）。 */
function gnssSignalColor(level: number): string {
  if (level >= 4) return colors.success;
  if (level >= 2) return colors.accentGreen;
  return colors.accentAmber;
}

/* ── GPS 速度 / 加速度 hook ── */
type GpsStatus = 'off' | 'idle' | 'active' | 'denied' | 'unavailable';

function useGpsSpeed(isFocused: boolean, enabled: boolean, demoMode: boolean): {
  speedKmh: number;
  acceleration: number | null;
  accuracyM: number | null;
  status: GpsStatus;
  gnss: GnssStatusData | null;
  openSettings: () => void;
} {
  const [speedKmh, setSpeedKmh] = useState(0);
  const [acceleration, setAcceleration] = useState<number | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [status, setStatus] = useState<GpsStatus>(enabled ? 'idle' : 'off');

  const [gnss, setGnss] = useState<GnssStatusData | null>(null);
  const gnssSubRef = useRef<ReturnType<typeof addGnssListener> | null>(null);

  const subRef = useRef<Location.LocationSubscription | null>(null);
  const lastFixRef = useRef(0);
  const lastVRef = useRef(0); // m/s
  const lastTRef = useRef(0); // ms
  const speedEmaRef = useRef(0); // km/h — 采样侧目标值
  const accelEmaRef = useRef<number | null>(null);
  const statusRef = useRef<GpsStatus>(status);
  statusRef.current = status;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const stopWatch = useCallback(() => {
    subRef.current?.remove();
    subRef.current = null;
    gnssSubRef.current?.remove();
    gnssSubRef.current = null;
    stopGnssStatus().catch(() => {});
  }, []);

  const startWatch = useCallback(async () => {
    if (demoMode) return;
    if (!enabledRef.current) return;
    gnssSubRef.current?.remove();
    gnssSubRef.current = null;
    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        setStatus(perm === 'denied' ? 'denied' : 'idle');
        return;
      }
      setStatus('active');
      startGnssStatus()
        .then(() => { gnssSubRef.current = addGnssListener(setGnss); })
        .catch(() => { /* GNSS 不可用（iOS / 旧安卓）静默降级 */ });
      const sub = await Location.watchPositionAsync(
        // 尽量高频：实际出帧率受系统限制（多数安卓 1Hz），显示侧另有平滑。
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 250, distanceInterval: 0 },
        (loc) => {
          const raw = loc.coords.speed; // m/s, 可能为 null 或负值
          let v = raw != null && raw > 0 ? raw : 0;
          // 室内/楼内飘速抑制：精度差（>15m）且读数低于步行速度时按 0 处理，
          // 否则停着不动速度环会一直 2-5 km/h 乱跳。
          const acc = loc.coords.accuracy;
          if (acc != null && acc > 15 && v * 3.6 < 3.6) v = 0;
          const now = Date.now();
          const dt = lastTRef.current > 0 ? (now - lastTRef.current) / 1000 : 0;
          if (dt > 0 && dt < 5) {
            const a = (v - lastVRef.current) / dt; // m/s²
            if (Math.abs(a) < 20) { // 尖刺防护：GPS 抖动
              accelEmaRef.current = accelEmaRef.current == null ? a : accelEmaRef.current * 0.5 + a * 0.5;
              setAcceleration(accelEmaRef.current);
            }
          }
          lastVRef.current = v;
          lastTRef.current = now;
          lastFixRef.current = now;
          const kmh = v * 3.6;
          // 0.8 新值权重（原 0.7）：采样侧更快跟上，残留阶梯感由显示平滑吸收。
          speedEmaRef.current = speedEmaRef.current * 0.2 + kmh * 0.8;
          if (acc != null) setAccuracyM(acc);
        },
      );
      subRef.current = sub;
    } catch {
      setStatus('unavailable');
    }
  }, [demoMode]);

  // Demo GPS never requests location permission or reads the device sensor.
  // It follows the same deterministic motion curve as the demo BMS frame.
  useEffect(() => {
    if (!demoMode) return;
    stopWatch();
    const tick = () => {
      if (!enabled) {
        setSpeedKmh(0); setAcceleration(null); setAccuracyM(null); setGnss(null); setStatus('off');
        return;
      }
      const motion = getDemoMotion();
      setSpeedKmh(motion.speedKmh); setAcceleration(motion.acceleration); setAccuracyM(3);
      setGnss({ totalSatellites: 18, usedSatellites: 13, signalLevel: 4, constellations: { GPS: 8, GLONASS: 3, BEIDOU: 5, GALILEO: 2, QZSS: 0, IRNSS: 0, SBAS: 0, UNKNOWN: 0 } });
      setStatus('active');
    };
    tick();
    const id = setInterval(tick, 120);
    return () => clearInterval(id);
  }, [demoMode, enabled, stopWatch]);

  // 显示侧平滑：100ms 步进向采样目标值靠拢（每步 30%），把 1-2Hz 的
  // GPS 出帧渲染成连续变化，消除"一卡一卡"的阶梯感。
  useEffect(() => {
    if (!enabled || demoMode) return;
    const id = setInterval(() => {
      setSpeedKmh((prev) => {
        const target = speedEmaRef.current;
        const next = prev + (target - prev) * 0.3;
        return Math.abs(next - target) < 0.05 ? target : next;
      });
    }, 33);
    return () => clearInterval(id);
  }, [demoMode, enabled]);

  // 看门狗：超过 2s 无新定位 → 视为停车，速度归零、加速度清零。
  useEffect(() => {
    if (!enabled || demoMode) return;
    const id = setInterval(() => {
      if (Date.now() - lastFixRef.current > 2000) {
        speedEmaRef.current = 0;
        setAcceleration(null);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [demoMode, enabled]);

  // 开关变化：关闭 = 立即停止一切定位/GNSS 调用并清零（后台零 GPS 行为）。
  useEffect(() => {
    if (demoMode) return;
    if (!enabled) {
      stopWatch();
      speedEmaRef.current = 0;
      accelEmaRef.current = null;
      lastFixRef.current = 0;
      lastTRef.current = 0;
      lastVRef.current = 0;
      setSpeedKmh(0);
      setAcceleration(null);
      setAccuracyM(null);
      setGnss(null);
      setStatus('off');
      return;
    }
    setStatus('idle');
  }, [demoMode, enabled, stopWatch]);

  // 仅在本 tab 聚焦且开关开启时开启 GPS，离开即停（省电 + 不抢其它 tab）。
  useEffect(() => {
    if (demoMode) return;
    if (!isFocused || !enabled) {
      stopWatch();
      return;
    }
    if (statusRef.current === 'denied' || statusRef.current === 'unavailable') return;
    startWatch();
    return () => { stopWatch(); };
  }, [demoMode, isFocused, enabled, startWatch, stopWatch]);

  // 从系统设置返回后重新探测权限（用户可能在设置里开了定位）。
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (!demoMode && st === 'active' && enabledRef.current &&
          (statusRef.current === 'denied' || statusRef.current === 'idle' || statusRef.current === 'unavailable')) {
        startWatch();
      }
    });
    return () => sub.remove();
  }, [demoMode, startWatch]);

  const openSettings = useCallback(() => {
    setStatus('idle');
    Linking.openSettings();
  }, []);

  return { speedKmh, acceleration, accuracyM, gnss, status, openSettings };
}

/* ── GPS 区隔离组件 ──
 * useGpsSpeed 内含 4 个高频 setState（速度 / 加速度 / 精度 / 卫星）。若直接放在
 * DashboardScreenInner 里，每次 GPS 更新都会拖着整个 1000+ 行的驾驶舱重渲染，
 * 在低端机上表现为速度环"卡卡"。这里把 GPS 状态整体封装进 GpsSection，高频更新
 * 只重渲染这一小块；SpeedHero / GnssCard 再各自 memo，互不拖累。 */
const SpeedHero = memo(function SpeedHero({
  speedKmh, acceleration, accuracyM, gpsEnabled, onEnable, onClose, powerW, voltageV, rangeKm,
}: {
  speedKmh: number; acceleration: number | null; accuracyM: number | null;
  gpsEnabled: boolean; onEnable: () => void; onClose: () => void;
  powerW: number | null; voltageV: number | null; rangeKm: number | null;
}) {
  const rs = useResponsive();
  const { colors: c, theme, resolvedMode } = useAppTheme();
  const avatar = resolveThemeAsset(theme.pack, 'dashboardAvatar', resolvedMode);
  const ticks = Array.from({ length: 17 });
  return (
    <Card style={s.speedHeroCard}>
      <Pressable
        disabled={gpsEnabled}
        onPress={onEnable}
        style={({ pressed }) => [s.speedHud, !gpsEnabled && pressed && { opacity: 0.75 }]}
      >
        <View style={[s.hudGlow, { backgroundColor: c.primary }]} />
        {avatar ? <View style={[s.hudAvatarFrame, { width: theme.pack.dashboard.avatarSize, height: theme.pack.dashboard.avatarSize }]}><Image source={avatar} resizeMode="cover" style={[s.hudAvatar, theme.pack.dashboard.avatarCrop === 'upper' && s.hudAvatarUpper, { opacity: theme.pack.dashboard.decorationOpacity }]} /></View> : null}
        <View style={s.hudState}><View style={[s.hudStateDot, { backgroundColor: gpsEnabled ? c.success : c.textDim }]} /><AppText style={[s.hudStateText, { color: c.textSecondary }]}>{gpsEnabled ? 'GPS LIVE' : 'GPS OFF'}</AppText></View>
        <View style={s.hudTicks}>{ticks.map((_, i) => <View key={i} style={[s.hudTick, { opacity: i <= Math.round((gpsEnabled ? speedKmh : 0) / SPEED_MAX_KMH * (ticks.length - 1)) ? 0.9 : 0.34, backgroundColor: i <= Math.round((gpsEnabled ? speedKmh : 0) / SPEED_MAX_KMH * (ticks.length - 1)) ? c.primary : c.textDim }, { transform: [{ rotate: `${-58 + i * 7.25}deg` }, { translateY: -70 }] }]} />)}</View>
        <AppText maxFontSizeMultiplier={1.3} style={[s.speedNum, { color: c.textPrimary, fontSize: Math.round(64 * rs.heroScale) }]}>{gpsEnabled ? Math.round(speedKmh) : '--'}</AppText>
        <AppText style={[s.speedUnit, { color: c.textMuted }]}>{gpsEnabled ? 'km/h' : ''}</AppText>
        <AppText style={[s.speedLabel, { color: c.textMuted }]}>{gpsEnabled ? 'GPS 实时车速' : 'GPS 车速已关闭 · 点击开启'}</AppText>
      </Pressable>
      <View style={[s.driveMetrics, { borderTopColor: c.borderSubtle }]}>
        <DriveMetric label="实时功率" value={powerW == null ? '--' : `${powerW > 0 ? '+' : ''}${Math.round(powerW)}`} unit="W" icon="flash-outline" />
        <DriveMetric label="加速度" value={acceleration == null ? '--' : `${acceleration >= 0 ? '+' : ''}${acceleration.toFixed(1)}`} unit="m/s²" icon={accelIcon(acceleration)} />
        <DriveMetric label="电压" value={voltageV == null ? '--' : voltageV.toFixed(1)} unit="V" icon="pulse-outline" />
        <DriveMetric label="剩余续航" value={rangeKm == null ? '--' : rangeKm.toFixed(1)} unit="km" icon="navigate-outline" />
      </View>
      {gpsEnabled && (
        <AppText style={[s.accelHint, { color: c.textMuted }]} onPress={onClose}>
          GPS 精度 {accuracyM != null ? `±${Math.round(accuracyM)}m` : '等待中'} · 点此关闭测速
        </AppText>
      )}
    </Card>
  );
});

function DriveMetric({ label, value, unit, icon }: { label: string; value: string; unit: string; icon: keyof typeof Ionicons.glyphMap }) {
  const { colors: c } = useAppTheme();
  return <View style={s.driveMetric}><View style={s.driveMetricLabelRow}><Ionicons name={icon} size={12} color={c.textMuted} /><AppText style={[s.driveMetricLabel, { color: c.textMuted }]}>{label}</AppText></View><View style={s.driveMetricValueRow}><AppText maxFontSizeMultiplier={1.3} style={[s.driveMetricValue, { color: c.textPrimary }]} numberOfLines={1}>{value}</AppText><AppText style={[s.driveMetricUnit, { color: c.textMuted }]}>{unit}</AppText></View></View>;
}

const GnssCard = memo(function GnssCard({
  gnss, status, gpsEnabled, onEnable,
}: {
  gnss: GnssStatusData | null; status: GpsStatus; gpsEnabled: boolean; onEnable: () => void;
}) {
  const { colors: c } = useAppTheme();
  return (
    <Card style={s.cardSpacing}>
      <SectionHeader
        icon="locate-outline"
        title="定位 · 卫星"
        accessory={
          gnss ? (
            <View style={s.gnssSignalWrap}>
              {[1, 2, 3, 4].map((lv) => {
                const on = lv <= gnss.signalLevel;
                return (
                  <View
                    key={lv}
                    style={[s.gnssSignalBar, { height: 5 + lv * 3, backgroundColor: on ? c.primary : c.border }]}
                  />
                );
              })}
            </View>
          ) : undefined
        }
      />
      {!gpsEnabled ? (
        <Pressable onPress={onEnable} hitSlop={6}>
          <AppText style={[s.gnssEmpty, { color: c.primary }]}>GPS 已关闭（默认省电，室内会飘速）· 点此开启</AppText>
        </Pressable>
      ) : gnss ? (
        <>
          <View style={s.gnssRow}>
            <AppText style={[s.gnssBig, { color: c.textPrimary }]}>{gnss.totalSatellites}</AppText>
            <AppText style={[s.gnssUnit, { color: c.textMuted }]}>颗可见</AppText>
            <AppText style={[s.gnssDot, { color: c.textMuted }]}>·</AppText>
            <AppText style={[s.gnssMid, { color: c.textPrimary }]}>{gnss.usedSatellites}</AppText>
            <AppText style={[s.gnssUnit, { color: c.textMuted }]}>颗定位</AppText>
          </View>
          <View style={s.gnssConstRow}>
            {CONSTELLATIONS.filter((c) => (gnss.constellations[c.key] ?? 0) > 0).map((c) => (
              <View key={c.key} style={[s.gnssConstChip, { backgroundColor: c.bg }]}>
                <AppText style={[s.gnssConstName, { color: c.fg }]}>{c.label}</AppText>
                <AppText style={[s.gnssConstNum, { color: c.fg }]}>{gnss.constellations[c.key]}</AppText>
              </View>
            ))}
          </View>
        </>
      ) : (
        <AppText style={[s.gnssEmpty, { color: c.textMuted }]}>
          {status === 'denied' ? '定位权限被拒，无法读取卫星' : status === 'active' ? '等待卫星信号…' : 'GPS 未启动'}
        </AppText>
      )}
    </Card>
  );
});

function GpsSection({ isFocused, gpsEnabled, onEnable, onClose, powerW, voltageV, rangeKm, demoMode }: {
  isFocused: boolean; gpsEnabled: boolean; onEnable: () => void; onClose: () => void;
  powerW: number | null; voltageV: number | null; rangeKm: number | null; demoMode: boolean;
}) {
  const gps = useGpsSpeed(isFocused, gpsEnabled, demoMode);
  return (
    <>
      {gps.status === 'denied' && (
        <Pressable style={s.gpsBanner} onPress={gps.openSettings}>
          <Ionicons name="location-outline" size={15} color={colors.danger} />
          <AppText style={s.gpsBannerText}>定位权限未开启，无法测速 · 点此前往设置开启</AppText>
        </Pressable>
      )}
      <SpeedHero
        speedKmh={gps.speedKmh}
        acceleration={gps.acceleration}
        accuracyM={gps.accuracyM}
        gpsEnabled={gpsEnabled}
        onEnable={onEnable}
        onClose={onClose}
        powerW={powerW}
        voltageV={voltageV}
        rangeKm={rangeKm}
      />
      <GnssCard gnss={gps.gnss} status={gps.status} gpsEnabled={gpsEnabled} onEnable={onEnable} />
    </>
  );
}

function speedRingColor(kmh: number): string {
  if (kmh <= 0.5) return colors.textMuted;
  if (kmh <= 15) return colors.success;
  if (kmh <= 30) return colors.primary;
  if (kmh <= 45) return colors.warning;
  return colors.danger;
}
function accelIcon(a: number | null): keyof typeof Ionicons.glyphMap {
  if (a == null) return 'remove-outline';
  return a > 0.05 ? 'arrow-up' : a < -0.05 ? 'arrow-down' : 'remove-outline';
}
function accelColor(a: number | null): string {
  if (a == null) return colors.textMuted;
  return a > 0.05 ? colors.success : a < -0.05 ? colors.warning : colors.textMuted;
}

/** 14S 高压包电压颜色：<43V 危险，<47V 偏低，其余正常。 */
function voltAccent(v: number | null): string | undefined {
  if (v == null) return undefined;
  return v < 43 ? colors.danger : v < 47 ? colors.warning : undefined;
}
/** 温度颜色：>50°C 危险，>40°C / <5°C 预警，<0°C 偏低。 */
function tempAccent(t: number | null): string | undefined {
  if (t == null) return undefined;
  return (t < 0 || t > 50) ? colors.danger : (t > 40 || t < 5) ? colors.warning : undefined;
}

/** A distinct hierarchy for the driving tab: protection-board telemetry first,
 * GPS driving instruments second. */
function LiveBoardHero({ frame, maxTemp, live, ageSeconds }: { frame: BmsFrame; maxTemp: number | null; live: boolean; ageSeconds: number | null }) {
  const { colors: c } = useAppTheme();
  const power = frame.power_w;
  const powerText = power == null ? '--' : `${power > 0 ? '+' : ''}${Math.round(power)}`;
  const soc = frame.soc_pct == null ? '--' : `${Math.round(frame.soc_pct)}%`;
  return (
    <View style={[s.liveBoardHero, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
      <View style={[s.liveBoardGlow, { backgroundColor: c.primarySoft }]} />
      <View style={s.liveBoardHeader}>
        <View style={s.liveBoardKicker}>
          <View style={s.livePulse} />
          <AppText style={[s.liveBoardKickerText, { color: c.textSecondary }]}>{live ? '保护板实时数据' : `保护板已连接 · 最近数据 ${ageSeconds == null ? '未知' : `${Math.max(1, Math.floor(ageSeconds / 60))} 分钟前`}`}</AppText>
        </View>
        <View style={[s.liveBoardCrc, { backgroundColor: c.surfaceSecondary }]}>
          <Ionicons name={frame.crcOk ? 'shield-checkmark-outline' : 'warning-outline'} size={13} color={frame.crcOk ? colors.accentGreen : colors.accentAmber} />
          <AppText style={[s.liveBoardCrcText, { color: c.textSecondary }]}>{live ? (frame.crcOk ? '实时已校验' : '待校验') : '非实时帧'}</AppText>
        </View>
      </View>
      <View style={s.liveBoardMain}>
        <View style={{ flex: 1 }}>
          <AppText style={[s.livePowerLabel, { color: c.textMuted }]}>板端功率</AppText>
          <View style={s.livePowerRow}>
            <AppText style={[s.livePowerValue, { color: c.textPrimary }]}>{powerText}</AppText>
            <AppText style={[s.livePowerUnit, { color: c.textMuted }]}>W</AppText>
          </View>
          <AppText style={[s.liveCurrentText, { color: c.textMuted }]}>{frame.current_a == null ? '电流等待中' : `${frame.current_a > 0 ? '+' : ''}${frame.current_a.toFixed(1)} A · 实测`}</AppText>
        </View>
        <View style={s.liveSocTile}>
          <AppText style={s.liveSocValue}>{soc}</AppText>
          <AppText style={s.liveSocLabel}>保护板 SOC</AppText>
        </View>
      </View>
      <View style={s.liveFactsRow}>
        <LiveFact icon="flash-outline" label="总电压" value={frame.total_voltage_v == null ? '--' : frame.total_voltage_v.toFixed(1)} unit="V" />
        <LiveFact icon="thermometer-outline" label="最高温度" value={maxTemp == null ? '--' : maxTemp.toFixed(1)} unit="°C" />
        <LiveFact icon="layers-outline" label="单体数量" value={frame.cell_count == null ? '--' : `${frame.cell_count}`} unit="节" />
      </View>
    </View>
  );
}

function LiveFact({ icon, label, value, unit }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; unit: string }) {
  const { colors: c } = useAppTheme();
  return (
    <View style={s.liveFact}>
      <Ionicons name={icon} size={13} color={c.primary} />
      <View>
        <AppText style={[s.liveFactLabel, { color: c.textMuted }]}>{label}</AppText>
        <AppText style={[s.liveFactValue, { color: c.textPrimary }]}>{value}<AppText style={[s.liveFactUnit, { color: c.textMuted }]}> {unit}</AppText></AppText>
      </View>
    </View>
  );
}

// 仪表板（实时驾驶舱）：GPS 车速+加速度、实时功率/压差、实时温度/单体电压。
// 数据来自 S7 中继或手机 BLE 的实时 BMS 帧（流式），与「电池」页的 REST 慢变
// 状态/历史数据职责分离——前者看"正在发生"，后者看"电池状态与历史"。
function DashboardScreenInner() {
  const { top } = useHeaderTheme(headerThemes.dashboard);
  const rs = useResponsive();
  const { colors: c } = useAppTheme();
  const { isDemoMode } = useDemoMode();
  const bt = useAntBmsBluetooth();
  const { selectedSn: deviceSn, relay, snapshot, refreshRelay } = useVehicleData();
  const [pickerVisible, setPickerVisible] = useState(false);
  const lastUploadRef = useRef(0);
  const isFocused = useIsFocused();
  // GPS 车速默认关闭（设置页/点速度环可开）：关闭时零定位调用。
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const [, setDemoTick] = useState(0);
  useEffect(() => {
    if (!isFocused) return;
    let alive = true;
    getGpsSpeedEnabled().then((v) => { if (alive) setGpsEnabled(isDemoMode ? true : v); }).catch(() => {});
    return () => { alive = false; };
  }, [isDemoMode, isFocused]);
  useEffect(() => {
    if (!isDemoMode) return;
    const id = setInterval(() => setDemoTick((value) => value + 1), 500);
    return () => clearInterval(id);
  }, [isDemoMode]);
  const toggleGps = useCallback((v: boolean) => {
    setGpsEnabled(v);
    if (!isDemoMode) void setGpsSpeedEnabled(v);
  }, [isDemoMode]);
  const enableGps = useCallback(() => toggleGps(true), [toggleGps]);
  const disableGps = useCallback(() => toggleGps(false), [toggleGps]);

  // ── Relay (S7) live board telemetry — preferred source when available ──
  // 用「蚂蚁板是否物理连在 S7 中继上」(board_connected，来自心跳标志) 决定数据源，
  // 而非 board_fresh（需近 60s 内有实时帧）。中继约每 6 分钟才向服务器回传一帧，
  // 若按 board_fresh 判断，绝大多数时间会误判成「保护板未连接」且看不到任何数据。
  // A connected relay can still be carrying an old board frame. Only a frame
  // within the server's real-time window is allowed to drive this diagnostic
  // screen; otherwise the phone may reconnect and obtain a new measurement.
  // The S7 owns the BLE link both while frames are live and during a temporary
  // upload delay. Do not make the dashboard phone steal the board merely
  // because the newest server frame is 61 seconds old.
  const usingRelay = relay?.board_state === 'live' || relay?.board_state === 'connected_stale';
  const relayBoardLive = relay?.board_state === 'live';

  // 车辆锁定状态（九号车机经 ninecli）：lock===1 已锁定（静止），0/null 未锁定（活动）。
  // 用它判骑行，替代 GPS 速度——锁车绝对不骑行，且无需 GPS 权限、无定位延迟。
  const vehicleLock = snapshot?.lock ?? null;

  const btRef = useRef(bt);
  btRef.current = bt;
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;

  useEffect(() => {
    if (bt.status === 'connected') setPickerVisible(false);
  }, [bt.status]);

  // Release phone BLE when leaving the BMS tab (free the board for the relay/S7).
  useFocusEffect(useCallback(() => {
    return () => { btRef.current.disconnect(); };
  }, []));

  // Background → release phone BLE so the board can reconnect to the relay.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') btRef.current.disconnect();
    });
    return () => sub.remove();
  }, []);

  // Source orchestration: the ANT board bonds to ONE device at a time, and
  // the S7 relay is normally that device. Two rules keep the phone from
  // stealing the link:
  //  1. Relay holds (or is freshly talking to) the board → phone BLE stays OFF.
  //  2. Relay status not yet known (first fetch in flight) → WAIT instead of
  //     auto-connecting blind, which used to grab the board in the ~1s before
  //     the first relay poll landed and then fight the S7 for it.
  // Only when the relay is known-present-but-not-on-the-board (or absent) do
  // we fall back to phone BLE.
  const relayHoldsBoard = usingRelay;
  useEffect(() => {
    if (isDemoMode) {
      btRef.current.disconnect();
      return;
    }
    const b = btRef.current;
    if (relayHoldsBoard) {
      setPickerVisible(false);
      if (b.status === 'connected' || b.status === 'connecting' || b.status === 'reconnecting') {
        b.disconnect();
      }
      return;
    }
    if (relay == null) return; // 中继状态未知：宁可等一拍，不盲目抢连
    if (isFocusedRef.current && (b.status === 'idle' || b.status === 'disconnected')) {
      void b.autoConnect();
    }
  }, [isDemoMode, relayHoldsBoard, isFocused, relay == null]);

  // Poll relay status while the tab is focused. Base interval comes from the
  // server config (relay.poll_ms); when the vehicle is KNOWN to be unlocked
  // (lock === 0), tighten to 1 s for a near-real-time feel. A null lock (first
  // load, or the last snapshot fetch failed) is NOT "riding" — treating it as
  // such pinned the relay poll at 1 s forever whenever ninecli was unreachable.
  const relayPollMs = relay?.poll_ms ?? 5000;
  const ridingNow = vehicleLock === 0;
  // 动态刷新：仅当「GPS 车速记录启用 + 骑行中」才激进轮询 1s；其余（GPS 关 / 停放）
  // 回落到 relay_poll_ms（默认 5s），既顺滑又省电省流量。
  const relayRefreshMs = (gpsEnabled && ridingNow) ? 1000 : relayPollMs;
  useEffect(() => {
    if (isDemoMode || !deviceSn || !isFocused) return;
    let alive = true;
    const load = async () => {
      try {
        // 上报 GPS+骑行 状态，后端据此驱动中继动态上行间隔（激进 1s / 缓慢 5s）。
        await refreshRelay({ gpsActive: gpsEnabled, riding: ridingNow });
      } catch { /* keep last known relay state */ }
    };
    load();
    const t = setInterval(load, relayRefreshMs);
    return () => { clearInterval(t); };
  }, [deviceSn, isDemoMode, isFocused, gpsEnabled, relayRefreshMs, refreshRelay]);

  useEffect(() => {
    if (bt.isScanning) setPickerVisible(true);
  }, [bt.isScanning]);


  // Upload only the PHONE's own BLE frame (never the relay's — that data already
  // lives on the server, posted by the S7 relay, and re-uploading would duplicate it).
  useEffect(() => {
    if (isDemoMode) return;
    const phoneFrame = bt.frame;
    if (!phoneFrame || !deviceSn) return;
    // A frame that failed CRC carries garbage in every field; uploading it
    // would make it the newest row and thus the dashboard's "live" reading.
    if (phoneFrame.crcOk === false) return;
    const now = Date.now();
    if (now - lastUploadRef.current < UPLOAD_THROTTLE_MS) return;
    lastUploadRef.current = now;
    void postBmsSnapshot(deviceSn, {
      captured_at: new Date().toISOString(),
      cell_count: phoneFrame.cell_count,
      cells_mv: phoneFrame.cells_mv,
      total_voltage_v: phoneFrame.total_voltage_v,
      current_a: phoneFrame.current_a,
      soc_pct: phoneFrame.soc_pct,
      soh_pct: phoneFrame.soh_pct,
      capacity_total_ah: phoneFrame.capacity_total_ah,
      capacity_remaining_ah: phoneFrame.capacity_remaining_ah,
      power_w: phoneFrame.power_w,
      temps_c: phoneFrame.temps_c,
      runtime_seconds: phoneFrame.runtime_seconds,
      crc_ok: phoneFrame.crcOk,
    });
  }, [bt.frame, deviceSn, isDemoMode]);

  // Unified display frame: relay live data when fresh, else the phone BLE frame.
  const demoBms = isDemoMode ? getDemoBms() : null;
  const displayFrame: BmsFrame | null = demoBms ? ({
    cell_count: demoBms.cell_count, cells_mv: demoBms.cells_mv ?? [], total_voltage_v: demoBms.total_voltage_v,
    current_a: demoBms.current_a, soc_pct: demoBms.soc_pct, soh_pct: demoBms.soh_pct, capacity_total_ah: demoBms.capacity_total_ah,
    capacity_remaining_ah: demoBms.capacity_remaining_ah, power_w: demoBms.power_w, temps_c: demoBms.temps_c ?? [],
    runtime_seconds: demoBms.runtime_seconds, crcOk: true,
  } as unknown as BmsFrame) : usingRelay && relay?.bms
    ? ({
        cell_count: relay.bms.cell_count,
        cells_mv: (relay.bms.cells_mv ?? []) as number[],
        total_voltage_v: relay.bms.total_voltage_v,
        current_a: relay.bms.current_a,
        soc_pct: relay.bms.soc_pct,
        soh_pct: relay.bms.soh_pct,
        capacity_total_ah: relay.bms.capacity_total_ah,
        capacity_remaining_ah: relay.bms.capacity_remaining_ah,
        power_w: relay.bms.power_w,
        temps_c: (relay.bms.temps_c ?? []) as (number | null)[],
        runtime_seconds: relay.bms.runtime_seconds,
        crcOk: relay.bms.crc_ok ?? false,
      } as unknown as BmsFrame)
    : bt.status === 'connected' ? bt.frame : null;

  // 单体平衡明细与逐探头温度已迁移到「电池」页的可折叠卡片（默认折叠）；
  // 本页只保留骑行时在意的聚合值。
  const temps = displayFrame?.temps_c ?? [];
  const validTemps = temps.filter((t): t is number => t != null);
  const maxTemp = validTemps.length > 0 ? Math.max(...validTemps) : null;

  const cardAnims = useStagger(2);

  return (
    <ScrollView style={[s.container, { backgroundColor: c.background }]} contentContainerStyle={{ paddingHorizontal: rs.pagePad, paddingTop: top, paddingBottom: 40 }}>
      {/* ── 数据源状态条：一眼看清数据来自中继还是手机蓝牙 ── */}
      <SourceBar
        usingRelay={usingRelay}
        btStatus={bt.status}
        relayLabel={usingRelay && relay?.bms
          ? `S7 中继 · ${relay.bms.total_voltage_v != null ? `${relay.bms.total_voltage_v.toFixed(1)}V` : '--'} · ${relay.bms.soc_pct != null ? `${Math.round(relay.bms.soc_pct)}%` : '--'}`
          : null}
        riding={ridingNow}
        bleStatus={usingRelay ? relay?.ble_status : null}
      />

      {/* ── Relay-priority banner ── */}
      {false && usingRelay && (
        <View style={s.relayBanner}>
          <Ionicons name="cloud-done-outline" size={15} color={colors.accentGreen} />
          <AppText style={s.relayBannerText}>数据来自 S7 中继 · 蚂蚁保护板已连接并回传（手机蓝牙已让出连接）</AppText>
        </View>
      )}

      {/* ── CRC failure warning：坏帧的总压/单体电压可能错位，不能当真实板数据 ── */}
      {displayFrame != null && displayFrame.crcOk === false && (
        <View style={s.crcBanner}>
          <Ionicons name="warning-outline" size={15} color={colors.accentAmber} />
          <AppText style={s.crcBannerText}>本帧 CRC 校验未通过，电压/单体数据可能错位，仅供参考</AppText>
        </View>
      )}

      <GpsSection isFocused={isFocused} gpsEnabled={gpsEnabled} onEnable={enableGps} onClose={disableGps} demoMode={isDemoMode}
        powerW={displayFrame?.power_w ?? null} voltageV={displayFrame?.total_voltage_v ?? snapshot?.bms_voltage ?? null} rangeKm={snapshot?.primary?.range_km ?? null} />

      {displayFrame && <LiveBoardHero frame={displayFrame} maxTemp={maxTemp} live={usingRelay ? relayBoardLive : true} ageSeconds={usingRelay ? relay?.board_frame_age_seconds ?? null : 0} />}

      {!displayFrame && (
        <View style={s.noBmsNote}>
          <Ionicons name="speedometer-outline" size={26} color={colors.textMuted} />
          <AppText style={s.noBmsNoteText}>
            {relay?.connected && !usingRelay
              ? '中继在线 · 保护板未连接，功率 / 电压数据暂不可用'
              : '未连接 BMS，功率 / 电压数据暂不可用 · 点击上方连接读取'}
          </AppText>
        </View>
      )}

      {/* GPS 区（定位 banner / 速度环 / 卫星卡）已封装进上方 <GpsSection /> */}

      {/* ── 连接蚂蚁保护板（最底部）── */}
      {!usingRelay && <StatusCard
        mode={usingRelay ? 'relay' : 'phone'}
        status={bt.status}
        deviceName={bt.deviceName}
        error={bt.error}
        relayLabel={usingRelay && relay?.bms
          ? `S7 中继 · ${relay.bms.total_voltage_v != null ? `${relay.bms.total_voltage_v.toFixed(1)}V` : '--'} / ${relay.bms.soc_pct != null ? `${Math.round(relay.bms.soc_pct)}%` : '--'}`
          : null}
        onConnect={() => {
          setPickerVisible(true);
          bt.connect();
        }}
        onDisconnect={bt.disconnect}
      />}

      <DevicePickerModal
        visible={pickerVisible}
        devices={bt.scannedDevices}
        isScanning={bt.isScanning}
        connecting={bt.status === 'connecting' || bt.status === 'reconnecting'}
        error={bt.error}
        onPick={(d) => { void bt.connectToDevice(d); }}
        onRescan={bt.startScan}
        onCancel={() => setPickerVisible(false)}
      />
    </ScrollView>
  );
}

/* ── Sub-components ── */

/** 顶部数据源状态条：一眼看清数据来自中继还是手机蓝牙，骑行时显 LIVE。 */
function SourceBar({ usingRelay, btStatus, relayLabel, riding, bleStatus }: {
  usingRelay: boolean;
  btStatus: string;
  relayLabel?: string | null;
  riding: boolean;
  bleStatus?: string | null;
}) {
  const { colors: c } = useAppTheme();
  const isConn = btStatus === 'connected';
  const isConnecting = btStatus === 'connecting' || btStatus === 'reconnecting';
  const dot = usingRelay ? colors.accentGreen
    : isConn ? colors.accentGreen
    : isConnecting ? colors.accentAmber
    : colors.textMuted;
  const label = usingRelay ? 'S7 中继'
    : isConn ? '手机蓝牙直连'
    : isConnecting ? '连接中…'
    : '等待数据';
  return (
    <View style={[s.sourceBar, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
      <View style={[s.sourceDot, { backgroundColor: dot }]} />
      <AppText style={[s.sourceLabel, { color: c.textPrimary }]}>{label}</AppText>
      {relayLabel && <AppText style={[s.sourceSub, { color: c.textSecondary }]} numberOfLines={1}>{relayLabel}</AppText>}
      {bleStatus && (
        <AppText style={[s.sourceSub, { color: c.textSecondary }]} numberOfLines={1}>S7：{bleStatus}</AppText>
      )}
      <View style={{ flex: 1 }} />
      {riding && (
        <View style={s.liveBadge}>
          <View style={s.liveDot} />
          <AppText style={s.liveText}>骑行中</AppText>
        </View>
      )}
    </View>
  );
}

function StatusCard({ mode, status, deviceName, error, relayLabel, onConnect, onDisconnect }: {
  mode: 'relay' | 'phone';
  status: string; deviceName: string | null; error: string | null;
  relayLabel?: string | null;
  onConnect: () => void; onDisconnect: () => void;
}) {
  const isRelay = mode === 'relay';
  const isConnecting = status === 'connecting' || status === 'reconnecting';
  const isConnected = status === 'connected';
  const isError = status === 'error';

  const stateColor = isRelay ? colors.accentGreen
    : isConnected ? colors.accentGreen : isConnecting ? colors.accentAmber : isError ? colors.danger : colors.textMuted;
  const stateIcon: keyof typeof Ionicons.glyphMap = isRelay ? 'cloud-done-outline'
    : isConnected ? 'checkmark-circle' : isConnecting ? 'sync-outline' : isError ? 'alert-circle' : 'radio-button-off';
  const stateLabel = isRelay ? '中继在线'
    : isConnected ? '已连接' : isConnecting ? '连接中...' : isError ? '连接失败' : '未连接';
  const gradFrom = isRelay ? colors.successLight : isConnected ? colors.successLight : isConnecting ? colors.warningLight : isError ? colors.dangerLight : colors.card;
  const gradTo   = isRelay ? tint.successSoft : isConnected ? tint.successSoft : isConnecting ? tint.warningBorder : isError ? tint.dangerBorder : colors.cardAlt;
  const btnFrom = isRelay ? colors.accentGreen : isConnected || isConnecting ? colors.danger : colors.primary;
  const btnTo   = isRelay ? '#16a34a' : isConnected || isConnecting ? '#dc2626' : colors.primaryDark;

  return (
    <View style={[s.statusCard, { backgroundColor: gradFrom }]}>
      <View style={s.statusInner}>
        <View style={s.statusIconHalo}>
          {isConnecting
            ? <ScanRadar size={26} color={stateColor} />
            : <Ionicons name={stateIcon} size={26} color={stateColor} />}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <AppText style={[s.statusLabel, { color: stateColor }]}>{stateLabel}</AppText>
            {isConnecting && <LoadingDots />}
          </View>
          {isRelay && relayLabel && <AppText style={s.deviceName}>{relayLabel}</AppText>}
          {!isRelay && deviceName && <AppText style={s.deviceName}>{deviceName}</AppText>}
          {error && <AppText style={s.error}>{error}</AppText>}
        </View>
      </View>
      {isRelay ? (
        <View style={[s.statusBtn, { backgroundColor: 'transparent' }]}>
          <View style={[s.statusBtnGrad, { backgroundColor: colors.accentGreen }]}>
            <AppText style={s.statusBtnText}>经 S7 中继读取</AppText>
          </View>
        </View>
      ) : (
        <PressScale
          min={0.97}
          style={({ pressed }) => [s.statusBtn, pressed && { opacity: 0.9 }]}
          onPress={isConnected || isConnecting ? onDisconnect : onConnect}
        >
          <View style={[s.statusBtnGrad, { backgroundColor: btnFrom }]}>
            <AppText style={s.statusBtnText}>{isConnected || isConnecting ? '断开' : '连接 ANT-BMS'}</AppText>
          </View>
        </PressScale>
      )}
    </View>
  );
}

function ScanRadar({ size = 18, color = colors.warning }: { size?: number; color?: string }) {
  const scale = useRef(new Animated.Value(0.4)).current;
  const opacity = useRef(new Animated.Value(0.8)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, { toValue: 1, duration: 1100, useNativeDriver: true, easing: Easing.out(Easing.ease) }),
          Animated.timing(scale, { toValue: 0.4, duration: 0, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0, duration: 1100, useNativeDriver: true, easing: Easing.in(Easing.ease) }),
          Animated.timing(opacity, { toValue: 0.8, duration: 0, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.reset();
  }, [scale, opacity]);
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <Animated.View style={{
        position: 'absolute', width: size, height: size, borderRadius: size / 2,
        backgroundColor: color, opacity, transform: [{ scale }],
      }} />
      <Ionicons name="bluetooth" size={size * 0.55} color={colors.card} />
    </View>
  );
}

function DevicePickerModal({ visible, devices, isScanning, connecting, error, onPick, onRescan, onCancel }: {
  visible: boolean;
  devices: ScannedDevice[];
  isScanning: boolean;
  connecting: boolean;
  error: string | null;
  onPick: (d: ScannedDevice) => void;
  onRescan: () => void;
  onCancel: () => void;
}) {
  const sorted = [...devices].sort((a, b) => Number(b.matched) - Number(a.matched) || (b.rssi ?? -200) - (a.rssi ?? -200));
  const matches = devices.filter(d => d.matched);
  const headerText = connecting
    ? '正在建立 GATT 连接…'
    : isScanning ? `扫描中…（已发现 ${devices.length}）`
    : devices.length > 0 ? `扫描完成 · ${matches.length} 个疑似 BMS`
    : '未发现蓝牙设备';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={s.pickerOverlay}>
        <View style={s.pickerSheet}>
          <View style={s.pickerHeaderRow}>
            <ScanRadar size={22} />
            <AppText style={s.pickerHeaderTitle}>选择 ANT-BMS 设备</AppText>
            <Pressable onPress={onCancel} hitSlop={8} style={({ pressed }) => [s.pickerCloseBtn, pressed && { opacity: 0.6 }]}>
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
          <AppText style={s.pickerSubText}>{headerText}</AppText>

          {error && !connecting && (
            <View style={s.pickerErrorRow}>
              <Ionicons name="warning-outline" size={13} color={colors.danger} />
              <AppText style={s.pickerErrorText}>{error}</AppText>
            </View>
          )}

          {sorted.length === 0 ? (
            <View style={s.pickerEmptyBox}>
              {isScanning ? (
                <>
                  <ScanRadar size={56} color={colors.primary} />
                  <AppText style={s.pickerEmptyText}>正在搜索附近蓝牙设备…</AppText>
                  <AppText style={s.pickerEmptyHint}>请确保 BMS 已通电且蓝牙未连接其他手机</AppText>
                </>
              ) : (
                <>
                  <Ionicons name="bluetooth-outline" size={48} color={colors.textMuted} />
                  <AppText style={s.pickerEmptyText}>未发现任何设备</AppText>
                  <Pressable style={({ pressed }) => [s.pickerRescanBtn, pressed && { opacity: 0.85 }]} onPress={onRescan}>
                    <Ionicons name="refresh-outline" size={15} color={colors.card} style={{ marginRight: 6 }} />
                    <AppText style={s.pickerRescanBtnText}>重新扫描</AppText>
                  </Pressable>
                </>
              )}
            </View>
          ) : (
            <ScrollView style={s.pickerList} contentContainerStyle={s.pickerListContent}>
              {sorted.map((d, di) => (
                <FadeIn key={d.id} index={di} step={40}>
                <Pressable style={({ pressed }) => [s.pickerItem, pressed && { opacity: 0.7 }]}
                  onPress={() => onPick(d)} disabled={connecting}>
                  <View style={[s.pickerItemIcon, d.matched ? s.pickerItemIconMatched : s.pickerItemIconGeneric]}>
                    <Ionicons name="hardware-chip-outline" size={18} color={d.matched ? colors.primary : colors.textMuted} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={s.pickerItemTitleRow}>
                      <AppText style={s.pickerItemName} numberOfLines={1}>{d.name}</AppText>
                      {d.matched && <View style={s.pickerMatchBadge}><AppText style={s.pickerMatchBadgeText}>BMS 推荐</AppText></View>}
                    </View>
                    <AppText style={s.pickerItemId} numberOfLines={1}>{d.id}</AppText>
                  </View>
                  <View style={s.pickerRssiCol}>
                    {d.rssi != null && <AppText style={[s.pickerRssi, d.rssi > -60 ? { color: colors.success } : d.rssi > -85 ? { color: colors.warning } : { color: colors.danger }]}>{d.rssi} dBm</AppText>}
                    <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
                  </View>
                </Pressable>
                </FadeIn>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function LoadingDots() {
  const op1 = useRef(new Animated.Value(0.3)).current;
  const op2 = useRef(new Animated.Value(0.3)).current;
  const op3 = useRef(new Animated.Value(0.3)).current;
  const opacities = [op1, op2, op3];
  useEffect(() => {
    const anims = opacities.map((o, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(o, { toValue: 1, duration: 400, delay: i * 200, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
          Animated.timing(o, { toValue: 0.3, duration: 400, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        ])
      )
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.reset());
  }, []);
  return (
    <View style={{ flexDirection: 'row', gap: 3 }}>
      {opacities.map((o, i) => (
        <Animated.View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warning, opacity: o }} />
      ))}
    </View>
  );
}

export default function DashboardScreen() {
  return (
    <ErrorBoundary label="仪表盘">
      <DashboardScreenInner />
    </ErrorBoundary>
  );
}

/* ── Styles ── */

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  cardSpacing: { marginTop: spacing.lg },

  /* 顶部数据源状态条 */
  sourceBar: {
    marginTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.card, borderRadius: radius.lg, paddingVertical: 10, paddingHorizontal: spacing.md,
    borderWidth: 1, borderColor: colors.borderLight, ...shadow.subtle,
  } as any,
  sourceDot: { width: 9, height: 9, borderRadius: 4.5 },
  sourceLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  sourceSub: { fontSize: fontSize.xs, color: colors.textMuted, fontFamily: fontMono, flexShrink: 1, marginLeft: 2 },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.dangerLight,
    paddingVertical: 3, paddingHorizontal: 9, borderRadius: radius.full,
  } as any,
  liveDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.danger },
  liveText: { fontSize: 11, fontWeight: '800', color: colors.danger, letterSpacing: 0.5 },

  /* 骑行指标卡片 */
  ridingCard: { marginTop: spacing.lg },

  /* Status card */
  statusCard: {
    marginTop: spacing.lg,
    borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md,
    ...shadow.raised,
  } as any,
  relayBanner: {
    marginTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.successLight, borderRadius: radius.lg,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
  } as any,
  relayBannerText: { flex: 1, fontSize: fontSize.xs, color: colors.accentGreen, fontWeight: '600' },
  crcBanner: {
    marginTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.warningLight, borderRadius: radius.lg,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
  } as any,
  crcBannerText: { flex: 1, fontSize: fontSize.xs, color: colors.accentAmber, fontWeight: '600' },
  gpsBanner: {
    marginTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.dangerLight, borderRadius: radius.lg,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
  } as any,
  gpsBannerText: { flex: 1, fontSize: fontSize.xs, color: colors.danger, fontWeight: '600' },
  statusInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  statusIconHalo: { width: 56, height: 56, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.55)', justifyContent: 'center', alignItems: 'center', ...shadow.subtle as any },
  statusLabel: { fontSize: fontSize.lg, fontWeight: '800' },
  deviceName: { fontSize: fontSize.sm, color: colors.textMuted, fontFamily: fontMono, marginTop: 2 },
  error: { fontSize: fontSize.sm, color: colors.danger, marginTop: 4 },
  statusBtn: { borderRadius: radius.lg, overflow: 'hidden', marginTop: spacing.xs, ...shadow.subtle as any },
  statusBtnGrad: { paddingVertical: 13, alignItems: 'center' } as any,
  statusBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },

  /* Speed-first lightweight HUD */
  speedHeroCard: { marginTop: spacing.lg, padding: spacing.lg, overflow: 'hidden' },
  speedHud: { height: 188, alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' },
  hudGlow: { position: 'absolute', width: 238, height: 128, borderRadius: 119, opacity: 0.085, top: 37, transform: [{ scaleX: 1.08 }] },
  hudAvatarFrame: { position: 'absolute', right: 8, bottom: 5, overflow: 'hidden', borderRadius: 18 },
  hudAvatar: { position: 'absolute', width: '100%', height: '150%', left: 0, top: 0 },
  hudAvatarUpper: { width: '190%', height: '285%', left: '-45%', top: '-3%' },
  hudState: { position: 'absolute', top: 8, flexDirection: 'row', alignItems: 'center', gap: 5 },
  hudStateDot: { width: 5, height: 5, borderRadius: 3 },
  hudStateText: { fontSize: 9, fontWeight: '800', letterSpacing: 1.1 },
  hudTicks: { position: 'absolute', width: 184, height: 184, alignItems: 'center', justifyContent: 'center', top: 0 },
  hudTick: { position: 'absolute', width: 2, height: 9, borderRadius: 1 },
  speedNum: { fontSize: fontSize.displayLg, fontWeight: '800', color: colors.text, fontFamily: fontMono, lineHeight: fontSize.displayLg * 1.05 },
  speedUnit: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: -2 },
  speedLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, letterSpacing: 0.4 },
  driveMetrics: { borderTopWidth: 1, flexDirection: 'row', flexWrap: 'wrap', paddingTop: spacing.xs },
  driveMetric: { width: '50%', paddingVertical: 7, paddingHorizontal: spacing.sm },
  driveMetricLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  driveMetricLabel: { fontSize: fontSize.xs },
  driveMetricValueRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 3 },
  driveMetricValue: { fontSize: fontSize.xl, fontWeight: '800', fontFamily: fontMono, letterSpacing: -0.5, flexShrink: 1 },
  driveMetricUnit: { fontSize: fontSize.xs, marginLeft: 3 },
  accelText: { fontSize: fontSize.md, fontWeight: '700', fontFamily: fontMono },
  accelUnit: { fontSize: fontSize.xs, color: colors.textMuted },
  accelHint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.sm, textAlign: 'center' },

  /* Dual power / delta */
  dualRow: { flexDirection: 'row', alignItems: 'stretch' },
  dualDivider: { width: 1, backgroundColor: colors.borderLight, marginVertical: spacing.sm },

  /* No-BMS note */
  noBmsNote: {
    marginTop: spacing.lg, alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.card, borderRadius: radius.xl, paddingVertical: spacing.xl, paddingHorizontal: spacing.lg,
    borderWidth: 1, borderColor: colors.borderLight, borderStyle: 'dashed',
  } as any,
  noBmsNoteText: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },

  liveBoardHero: { position: 'relative', overflow: 'hidden', marginTop: spacing.md, marginBottom: spacing.md, padding: spacing.lg, borderRadius: radius.xxl, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight, ...shadow.card },
  liveBoardGlow: { position: 'absolute', right: -90, top: -120, width: 260, height: 260, borderRadius: 130, backgroundColor: colors.infoLight, opacity: 0.9 },
  liveBoardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  liveBoardKicker: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  livePulse: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#34D399', shadowColor: '#34D399', shadowOpacity: 0.9, shadowRadius: 7, elevation: 3 },
  liveBoardKickerText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  liveBoardCrc: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.cardAlt, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full },
  liveBoardCrcText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '600' },
  liveBoardMain: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg },
  livePowerLabel: { color: colors.textMuted, fontSize: fontSize.sm },
  livePowerRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 1 },
  livePowerValue: { color: colors.text, fontSize: 42, lineHeight: 48, fontWeight: '800', fontFamily: fontMono, letterSpacing: -2 },
  livePowerUnit: { color: colors.textMuted, fontSize: fontSize.lg, fontWeight: '700', marginLeft: 5 },
  liveCurrentText: { color: colors.textMuted, fontSize: fontSize.xs, fontFamily: fontMono, marginTop: 2 },
  liveSocTile: { minWidth: 88, alignItems: 'center', backgroundColor: colors.successLight, borderColor: tint.successBorder, borderWidth: 1, borderRadius: radius.xl, paddingVertical: 12, paddingHorizontal: 10 },
  liveSocValue: { color: colors.accentGreen, fontSize: fontSize.xxl, fontWeight: '800', fontFamily: fontMono },
  liveSocLabel: { color: tint.onSuccess, fontSize: 10, fontWeight: '600', marginTop: 2 },
  liveFactsRow: { flexDirection: 'row', marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.borderLight },
  liveFact: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveFactLabel: { color: colors.textMuted, fontSize: 10 },
  liveFactValue: { color: colors.text, fontFamily: fontMono, fontSize: fontSize.sm, fontWeight: '700', marginTop: 1 },
  liveFactUnit: { color: colors.textMuted, fontSize: 10, fontWeight: '500' },

  /* GNSS 定位 · 卫星 / 星座 */
  gnssSignalWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  gnssSignalBar: { width: 4, borderRadius: 2, backgroundColor: colors.borderLight },
  gnssRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: spacing.sm },
  gnssBig: { fontSize: fontSize.xl, fontWeight: '800', fontFamily: fontMono, color: colors.text },
  gnssMid: { fontSize: fontSize.lg, fontWeight: '700', fontFamily: fontMono, color: colors.text },
  gnssUnit: { fontSize: fontSize.xs, color: colors.textMuted },
  gnssDot: { fontSize: fontSize.md, color: colors.textMuted, marginHorizontal: 2 },
  gnssConstRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.sm },
  gnssConstChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 9, borderRadius: radius.full },
  gnssConstName: { fontSize: 11, fontWeight: '700' },
  gnssConstNum: { fontSize: 12, fontWeight: '800', fontFamily: fontMono },
  gnssEmpty: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: spacing.sm },

  /* Device picker modal */
  pickerOverlay: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  } as any,
  pickerSheet: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.xxl, borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: 32,
    maxHeight: '82%',
    ...shadow.raised,
  } as any,
  pickerHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 4 },
  pickerHeaderTitle: { flex: 1, fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  pickerCloseBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.cardAlt, justifyContent: 'center', alignItems: 'center' },
  pickerSubText: { fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.sm },
  pickerErrorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.dangerLight, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, marginBottom: spacing.sm },
  pickerErrorText: { flex: 1, fontSize: fontSize.sm, color: colors.danger },

  pickerList: { maxHeight: 380 } as any,
  pickerListContent: { gap: 8, paddingBottom: 12 },
  pickerItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 12, paddingHorizontal: spacing.md, backgroundColor: colors.cardAlt, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderLight },
  pickerItemIcon: { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  pickerItemIconMatched: { backgroundColor: colors.primaryLight },
  pickerItemIconGeneric: { backgroundColor: colors.card },
  pickerItemTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pickerItemName: { fontSize: fontSize.md, fontWeight: '600', color: colors.text, flexShrink: 1 },
  pickerMatchBadge: { backgroundColor: colors.primary, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  pickerMatchBadgeText: { fontSize: 10, fontWeight: '700', color: '#fff' },
  pickerItemId: { fontSize: 10, color: colors.textMuted, fontFamily: fontMono, marginTop: 2 },
  pickerRssiCol: { alignItems: 'flex-end', gap: 2 },
  pickerRssi: { fontSize: 11, fontWeight: '600', color: colors.textSecondary, fontFamily: fontMono },

  pickerEmptyBox: { alignItems: 'center', paddingVertical: 50, gap: 12 },
  pickerEmptyText: { fontSize: fontSize.md, color: colors.textSecondary, fontWeight: '500' },
  pickerEmptyHint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: 16 },
  pickerRescanBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primary, paddingVertical: 12, paddingHorizontal: 22, borderRadius: radius.lg },
  pickerRescanBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '600' },
});
