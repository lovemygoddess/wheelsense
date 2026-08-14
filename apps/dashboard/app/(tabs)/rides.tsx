import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { AppText } from '../../src/components/AppText';
import { EmptyState } from '../../src/components/EmptyState';
import { useAuth } from '../../src/auth';
import { fetchRides, fetchVehicles } from '../../src/api';
import { useHeaderTheme } from '../../src/hooks/useHeaderTheme';
import { useResponsive } from '../../src/hooks/useResponsive';
import { colors, fontMono, fontSize, headerThemes, radius, shadow, spacing } from '../../src/theme';
import type { Ride, RidesMeta } from '../../src/types';
import { useAppTheme } from '../../src/ThemeProvider';
import { resolveThemeAsset } from '../../src/themePacks';

const AUTO_REFRESH_MS = 30_000;

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(ym: string, offset: number): string {
  const date = new Date(Number(ym.slice(0, 4)), Number(ym.slice(4)) - 1 + offset, 1);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(ym: string): string {
  return `${ym.slice(0, 4)} 年 ${Number(ym.slice(4))} 月`;
}

function formatDate(value: string | null): string {
  if (!value) return '时间未知';
  const d = new Date(value);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatTime(value: string | null): string {
  if (!value) return '--:--';
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayKey(value: string | null): string {
  if (!value) return 'unknown';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayTitle(key: string): string {
  if (key === 'unknown') return '时间未知';
  const d = new Date(`${key}T00:00:00`);
  const now = new Date();
  const today = dayKey(now.toISOString());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yKey = dayKey(yesterday.toISOString());
  const prefix = key === today ? '今天' : key === yKey ? '昨天' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${prefix} · ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]}`;
}

function formatDuration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const seconds = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours}小时${minutes}分` : `${minutes} 分钟`;
}

export default function RidesScreen() {
  const { unlocked } = useAuth();
  const { top } = useHeaderTheme(headerThemes.rides);
  const rs = useResponsive();
  const { colors: c, theme, resolvedMode, dialogueEnabled } = useAppTheme();
  const tripCharacter = resolveThemeAsset(theme.pack, 'tripCharacter', resolvedMode);
  const [month, setMonth] = useState(currentMonth);
  const [rides, setRides] = useState<Ride[]>([]);
  const [meta, setMeta] = useState<RidesMeta | null>(null);
  const [selected, setSelected] = useState<Ride | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (refresh = false, requestedMonth?: string) => {
    if (!unlocked) return;
    const sequence = ++requestRef.current;
    const targetMonth = requestedMonth ?? month;
    try {
      refresh ? setRefreshing(true) : setLoading(true);
      setError(null);
      if (!snRef.current) {
        const vehicles = await fetchVehicles();
        snRef.current = vehicles[0]?.sn ?? null;
      }
      if (!snRef.current) throw new Error('未找到车辆');
      const response = await fetchRides(snRef.current, targetMonth);
      if (sequence !== requestRef.current) return;
      setRides(response.rides);
      setMeta(response.meta);
    } catch (e) {
      if (sequence === requestRef.current) setError(e instanceof Error ? e.message : '行程加载失败');
    } finally {
      if (sequence === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [month, unlocked]);

  useFocusEffect(useCallback(() => {
    load();
    const timer = setInterval(() => load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]));

  const changeMonth = (offset: number) => {
    const next = shiftMonth(month, offset);
    setMonth(next);
    load(false, next);
  };

  const average = useMemo(() => meta && meta.month_mileage > 0
    ? (meta.wh_per_km_learned ?? (meta.month_energy != null && meta.month_energy > 0 ? meta.month_energy / meta.month_mileage : null)) : null, [meta]);

  const sections = useMemo(() => {
    const grouped = new Map<string, Ride[]>();
    for (const ride of rides) {
      const key = dayKey(ride.started_at);
      const list = grouped.get(key) ?? [];
      list.push(ride);
      grouped.set(key, list);
    }
    return Array.from(grouped.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([key, rows]) => {
        const data = [...rows].sort((a, b) => new Date(b.started_at ?? 0).getTime() - new Date(a.started_at ?? 0).getTime());
        return ({
      key,
      title: dayTitle(key),
      count: data.length,
      mileage: data.reduce((sum, ride) => sum + ride.mileage, 0),
      data,
        });
      });
  }, [rides]);
  const todayRides = useMemo(() => rides.filter(ride => dayKey(ride.started_at) === dayKey(new Date().toISOString())), [rides]);
  const today = useMemo(() => ({
    mileage: todayRides.reduce((sum, ride) => sum + ride.mileage, 0),
    durationMin: Math.round(todayRides.reduce((sum, ride) => {
      if (!ride.started_at || !ride.ended_at) return sum;
      return sum + Math.max(0, new Date(ride.ended_at).getTime() - new Date(ride.started_at).getTime()) / 60000;
    }, 0)),
    energy: todayRides.reduce((sum, ride) => sum + Math.max(0, ride.energy ?? 0), 0),
    avgSpeed: todayRides.length ? todayRides.reduce((sum, ride) => sum + (ride.avg_speed_kph ?? 0) * ride.mileage, 0) / Math.max(0.01, todayRides.reduce((sum, ride) => sum + ride.mileage, 0)) : null,
  }), [todayRides]);

  return <View style={[s.container, { backgroundColor: c.background }]}>
    <SectionList
      sections={sections}
      keyExtractor={(ride) => ride.id}
      contentContainerStyle={{ paddingTop: top + spacing.sm, paddingHorizontal: rs.pagePad, paddingBottom: spacing.xl, flexGrow: 1 }}
      refreshControl={<RefreshControl tintColor={c.primary} refreshing={refreshing} onRefresh={() => load(true)} />}
      ListHeaderComponent={<>
        <View style={[s.todayHero, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
          <View style={[s.todayGlow, { backgroundColor: c.primary }]} />
          {tripCharacter ? <Image source={tripCharacter} resizeMode="contain" style={s.todayCharacter} /> : null}
          <AppText style={[s.todayEyebrow, { color: c.primary }]}>今日骑行</AppText>
          <View style={s.todayDistanceRow}><AppText maxFontSizeMultiplier={1.35} style={[s.todayDistance, { color: c.textPrimary }]}>{today.mileage.toFixed(1)}</AppText><AppText style={[s.todayDistanceUnit, { color: c.textMuted }]}>km</AppText></View>
          <View style={[s.todayFacts, { borderTopColor: c.borderSubtle }]}>
            <TodayFact value={today.durationMin >= 60 ? `${Math.floor(today.durationMin / 60)}h ${today.durationMin % 60}m` : `${today.durationMin} min`} label="骑行时长" />
            <TodayFact value={today.avgSpeed == null ? '--' : today.avgSpeed.toFixed(1)} label="平均 km/h" />
            <TodayFact value={today.energy > 0 ? `${today.energy.toFixed(0)} Wh` : '--'} label="总耗电" />
          </View>
          {dialogueEnabled && theme.pack.dialogue?.trip?.[0] ? <AppText style={[s.tripDialogue, { color: c.textMuted }]}>{theme.pack.dialogue.trip[0]}</AppText> : null}
        </View>
        <View style={[s.monthPanel, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
        <View style={s.monthNav}>
          <Pressable onPress={() => changeMonth(-1)} style={[s.monthButton, { backgroundColor: c.surfaceSecondary }]}><Ionicons name="chevron-back" size={19} color={c.textPrimary} /></Pressable>
          <View><AppText style={[s.eyebrow, { color: c.primary }]}>月度汇总</AppText><AppText style={[s.monthTitle, { color: c.textPrimary }]}>{monthLabel(month)}</AppText></View>
          <Pressable disabled={month >= currentMonth()} onPress={() => changeMonth(1)} style={[s.monthButton, { backgroundColor: c.surfaceSecondary }]}><Ionicons name="chevron-forward" size={19} color={month >= currentMonth() ? c.textDim : c.textPrimary} /></Pressable>
        </View>
        {meta && <View style={[s.monthHero, { backgroundColor: c.primarySoft }]}>
          <View style={s.monthMileageBlock}>
            <AppText style={[s.monthMetricLabel, { color: c.textSecondary }]}>本月骑行</AppText>
            <View style={s.monthMileageLine}><AppText style={[s.monthMileage, { color: c.primary }]}>{meta.month_mileage.toFixed(1)}</AppText><AppText style={[s.monthMileageUnit, { color: c.textMuted }]}>km</AppText></View>
          </View>
          <View style={s.monthSecondary}>
            <View style={[s.monthMini, { backgroundColor: c.surface }]}><AppText style={[s.monthMiniValue, { color: c.textPrimary }]}>{meta.month_ride_count}</AppText><AppText style={[s.monthMiniLabel, { color: c.textMuted }]}>次骑行</AppText></View>
            <View style={[s.monthMini, { backgroundColor: c.surface }]}><AppText style={[s.monthMiniValue, { color: c.textPrimary }]}>{average?.toFixed(1) ?? '--'}</AppText><AppText style={[s.monthMiniLabel, { color: c.textMuted }]}>Wh/km</AppText></View>
          </View>
        </View>}
        {meta && (
          <View style={s.energySourceNote}>
            <Ionicons name="shield-checkmark-outline" size={13} color={colors.accentGreen} />
            <AppText style={s.energySourceText}>
              {meta.wh_per_km_source === 'bms_measured' ? '保护板完整骑行实测' : meta.wh_per_km_source === 'voltage_model' ? '断联降级：电压模型' : '等待可信能耗样本'}
            </AppText>
          </View>
        )}
        </View>
        {error && <AppText style={s.error}>{error}</AppText>}
        {rides.length > 0 && <AppText style={s.listLabel}>按日期查看</AppText>}
      </>}
      renderSectionHeader={({ section }) => (
        <View style={s.dayHeader}>
          <View style={s.dayLine} />
          <View style={s.dayCopy}>
            <AppText style={s.dayTitle}>{section.title}</AppText>
            <AppText style={s.dayMeta}>{section.count} 次 · {section.mileage.toFixed(1)} km</AppText>
          </View>
        </View>
      )}
      renderItem={({ item }) => <RideRow ride={item} onPress={() => setSelected(item)} />}
      ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
      SectionSeparatorComponent={() => <View style={{ height: spacing.md }} />}
      stickySectionHeadersEnabled
      ListEmptyComponent={loading ? <ActivityIndicator color={colors.accentBlue} style={{ marginTop: 60 }} /> : !error ? <EmptyState variant="float" icon="bicycle-outline" title="本月暂无行程" subtitle="Ninebot 同步到新行程后会显示在这里。" accent={colors.textSecondary} accentBg={colors.cardAlt} /> : null}
    />
    <Modal transparent animationType="slide" visible={selected !== null} onRequestClose={() => setSelected(null)}>
      {selected && <RideDetail ride={selected} onClose={() => setSelected(null)} />}
    </Modal>
  </View>;
}

function RideRow({ ride, onPress }: { ride: Ride; onPress: () => void }) {
  const { colors: c } = useAppTheme();
  return <Pressable onPress={onPress} style={({ pressed }) => [s.row, { backgroundColor: c.surface, borderColor: c.borderSubtle }, pressed && { opacity: 0.72 }]}>
    <View style={s.timelineRail}><View style={[s.timelineDot, { backgroundColor: c.primary }]} /><View style={[s.timelineLine, { backgroundColor: c.border }]} /></View>
    <View style={s.dateBox}><AppText style={[s.dateText, { color: c.textMuted }]}>{formatTime(ride.started_at)}</AppText></View>
    <View style={s.rowBody}>
      <View style={s.rowTop}><AppText style={[s.distance, { color: c.textPrimary }]}>{ride.mileage.toFixed(1)} km</AppText>{ride.max_speed_kph != null && <AppText style={[s.peak, { color: c.warning }]}>极速 {ride.max_speed_kph.toFixed(1)}</AppText>}</View>
      <AppText style={[s.rowMeta, { color: c.textSecondary }]}>{formatDuration(ride.started_at, ride.ended_at) ?? '时长未知'} · 均速 {ride.avg_speed_kph?.toFixed(1) ?? '--'} km/h</AppText>
    </View>
    <Ionicons name="chevron-forward" size={17} color={c.textDim} />
  </Pressable>;
}

function RideDetail({ ride, onClose }: { ride: Ride; onClose: () => void }) {
  const { colors: c } = useAppTheme();
  const energyRate = ride.wh_per_km ?? (ride.energy != null && ride.mileage > 0 ? ride.energy / ride.mileage : null);
  const energyLabel = ride.energy_source === 'bms_interval'
    ? `保护板逐帧积分${ride.energy_coverage != null ? ` · 覆盖 ${Math.round(ride.energy_coverage * 100)}%` : ''}`
    : ride.energy_source === 'snapshot_voltage' || ride.energy_source === 'relay_voltage'
      ? '断联降级：静置电压估算'
      : '本车校准估算';
  return <View style={s.modalShade}><View style={[s.sheet, { backgroundColor: c.background }]}>
    <View style={[s.sheetHandle, { backgroundColor: c.border }]} />
    <View style={s.sheetTitleRow}><View><AppText style={[s.eyebrow, { color: c.primary }]}>骑行报告</AppText><AppText style={[s.sheetTitle, { color: c.textPrimary }]}>{formatDate(ride.started_at)}</AppText></View><Pressable onPress={onClose}><Ionicons name="close" size={24} color={c.textPrimary} /></Pressable></View>
    <View style={[s.detailHero, { backgroundColor: c.primarySoft }]}><AppText style={[s.detailDistance, { color: c.primary }]}>{ride.mileage.toFixed(2)} km</AppText><AppText style={[s.detailCaption, { color: c.textSecondary }]}>本次骑行里程</AppText></View>
    <DetailLine icon="time-outline" label="骑行时长" value={formatDuration(ride.started_at, ride.ended_at) ?? '--'} />
    <DetailLine icon="speedometer-outline" label="平均 / 极速" value={`${ride.avg_speed_kph?.toFixed(1) ?? '--'} / ${ride.max_speed_kph?.toFixed(1) ?? '--'} km/h`} />
    <DetailLine icon="flash-outline" label={energyLabel} value={ride.energy != null && ride.energy > 0 ? `${ride.energy.toFixed(0)} Wh` : '--'} />
    <DetailLine icon="analytics-outline" label="可信单位能耗" value={energyRate != null ? `${energyRate.toFixed(1)} Wh/km` : '--'} />
  </View></View>;
}

function DetailLine({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  const { colors: c } = useAppTheme();
  return <View style={[s.detailLine, { borderBottomColor: c.border }]}><Ionicons name={icon} size={18} color={c.primary} /><AppText style={[s.detailLabel, { color: c.textSecondary }]}>{label}</AppText><AppText style={[s.detailValue, { color: c.textPrimary }]}>{value}</AppText></View>;
}

function TodayFact({ value, label }: { value: string; label: string }) {
  const { colors: c } = useAppTheme();
  return <View style={s.todayFact}><AppText maxFontSizeMultiplier={1.35} style={[s.todayFactValue, { color: c.textPrimary }]}>{value}</AppText><AppText style={[s.todayFactLabel, { color: c.textMuted }]}>{label}</AppText></View>;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  todayHero: { padding: spacing.lg, marginBottom: spacing.md, borderRadius: radius.xl, borderWidth: 1, overflow: 'hidden' },
  todayGlow: { position: 'absolute', width: 210, height: 130, borderRadius: 105, opacity: 0.10, right: -65, top: -70 },
  todayCharacter: { position: 'absolute', width: 50, height: 76, right: 12, top: 8, opacity: 0.13 },
  tripDialogue: { marginTop: 7, fontSize: 10, textAlign: 'right', fontStyle: 'italic' },
  todayEyebrow: { fontSize: fontSize.sm, fontWeight: '700' },
  todayDistanceRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: spacing.xs },
  todayDistance: { fontSize: 44, lineHeight: 50, fontWeight: '800', fontFamily: fontMono, letterSpacing: -2 },
  todayDistanceUnit: { fontSize: fontSize.md, fontWeight: '700', marginLeft: 5 },
  todayFacts: { flexDirection: 'row', borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.md },
  todayFact: { flex: 1 },
  todayFactValue: { fontSize: fontSize.md, fontWeight: '800', fontFamily: fontMono },
  todayFactLabel: { fontSize: fontSize.xs, marginTop: 3 },
  monthPanel: { padding: spacing.lg, marginBottom: spacing.xl, borderRadius: radius.xl, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight, ...shadow.card },
  monthNav: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  monthButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardAlt },
  eyebrow: { color: colors.accentViolet, fontFamily: fontMono, fontSize: fontSize.xs, letterSpacing: 1.1 }, monthTitle: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700', marginTop: 2 },
  monthHero: { flexDirection: 'row', alignItems: 'stretch', gap: spacing.md, backgroundColor: '#f3f0ff', borderRadius: radius.xl, padding: spacing.lg },
  monthMileageBlock: { flex: 1, justifyContent: 'center' },
  monthMetricLabel: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  monthMileageLine: { flexDirection: 'row', alignItems: 'baseline', marginTop: spacing.xs },
  monthMileage: { color: colors.accentViolet, fontFamily: fontMono, fontSize: 38, lineHeight: 44, fontWeight: '800', letterSpacing: -1.5 },
  monthMileageUnit: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700', marginLeft: 4 },
  monthSecondary: { width: 92, gap: spacing.sm },
  monthMini: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.sm, borderRadius: radius.md, backgroundColor: colors.card },
  monthMiniValue: { color: colors.text, fontFamily: fontMono, fontSize: fontSize.lg, fontWeight: '800' },
  monthMiniLabel: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 1 },
  error: { color: colors.danger, marginBottom: spacing.md }, listLabel: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700', marginBottom: spacing.sm },
  energySourceNote: { marginTop: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  energySourceText: { color: colors.textMuted, fontSize: fontSize.xs },
  dayHeader: { flexDirection: 'row', alignItems: 'stretch', minHeight: 48, marginBottom: spacing.sm },
  dayLine: { width: 4, borderRadius: 3, backgroundColor: colors.accentViolet, marginRight: spacing.md },
  dayCopy: { flex: 1, justifyContent: 'center' },
  dayTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '800' },
  dayMeta: { marginTop: 2, color: colors.textMuted, fontSize: fontSize.xs, fontFamily: fontMono },
  row: { minHeight: 80, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderLight, padding: spacing.md, flexDirection: 'row', alignItems: 'center' }, timelineRail: { width: 18, alignSelf: 'stretch', alignItems: 'center' }, timelineDot: { width: 7, height: 7, borderRadius: 4, marginTop: 23 }, timelineLine: { width: 1, flex: 1, marginTop: 4, marginBottom: -spacing.md }, dateBox: { width: 52 }, dateText: { color: colors.textMuted, fontFamily: fontMono, fontSize: fontSize.xs, lineHeight: 18 }, rowBody: { flex: 1 }, rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, distance: { color: colors.text, fontSize: fontSize.lg, fontWeight: '700' }, peak: { color: colors.accentAmber, fontSize: fontSize.xs, fontFamily: fontMono }, rowMeta: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 4 },
  modalShade: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000088' }, sheet: { backgroundColor: colors.bg, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.lg, paddingBottom: spacing.xl }, sheetHandle: { alignSelf: 'center', width: 42, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md }, sheetTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, sheetTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: '700', marginTop: 3 }, detailHero: { marginVertical: spacing.lg, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.cardAlt }, detailDistance: { color: colors.accentBlue, fontSize: 32, fontWeight: '800' }, detailCaption: { color: colors.textSecondary, marginTop: 4 }, detailLine: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, detailLabel: { color: colors.textSecondary, marginLeft: spacing.sm, flex: 1 }, detailValue: { color: colors.text, fontFamily: fontMono, fontSize: fontSize.sm },
});
