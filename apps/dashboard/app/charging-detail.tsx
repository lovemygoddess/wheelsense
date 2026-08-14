import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText } from '../src/components/AppText';
import { Card } from '../src/components/Card';
import { fetchBatteryOverview } from '../src/api';
import { useAppTheme } from '../src/ThemeProvider';
import { useHeaderTheme } from '../src/hooks/useHeaderTheme';
import { headerThemes, fontMono, fontSize, radius, spacing } from '../src/theme';
import { useVehicleData } from '../src/vehicleData';
import type { ChargeEventRow } from '../src/types';

function fmtDate(value: string | null): string {
  if (!value) return '未知';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '未知';
}

function fmtVoltage(value: number | null): string {
  return value == null ? '暂无' : `${value.toFixed(2)} V`;
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start) return '时长未知';
  if (!end) return '进行中';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '时长未知';
  const mins = Math.round(ms / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟` : `${mins} 分钟`;
}

function DetailRow({ label, value, colors }: { label: string; value: string; colors: ReturnType<typeof useAppTheme>['colors'] }) {
  return <View style={[s.detailRow, { borderBottomColor: colors.borderSubtle }]}><AppText style={[s.detailLabel, { color: colors.textMuted }]}>{label}</AppText><AppText style={[s.detailValue, { color: colors.textPrimary }]}>{value}</AppText></View>;
}

export default function ChargingDetailScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const { top } = useHeaderTheme(headerThemes.battery);
  const params = useLocalSearchParams<{ id?: string; sn?: string }>();
  const { selectedSn } = useVehicleData();
  const [event, setEvent] = useState<ChargeEventRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sn = params.sn || selectedSn;
  const id = String(params.id ?? '');

  useEffect(() => {
    let active = true;
    (async () => {
      if (!sn || !id) { setLoading(false); return; }
      try {
        const overview = await fetchBatteryOverview(sn, 168);
        if (!active) return;
        setEvent(overview.charge_events.find(item => String(item.id) === id) ?? null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [id, sn]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { router.back(); return true; });
    return () => sub.remove();
  }, [router]);

  const rows = useMemo(() => event ? [
    ['开始时间', fmtDate(event.started_at)],
    ['结束时间', fmtDate(event.ended_at)],
    ['持续时长', fmtDuration(event.started_at, event.ended_at)],
    ['开始电压', fmtVoltage(event.start_voltage)],
    ['结束电压', fmtVoltage(event.end_voltage)],
    ['峰值电压', fmtVoltage(event.peak_voltage)],
    ['平均温度', event.avg_temp == null ? '暂无' : `${event.avg_temp.toFixed(1)} °C`],
    ['充电结果', event.is_full_charge ? '满电结束' : '未满电'],
    ['检测方式', event.detection_method || '未知'],
  ] : [], [event]);

  return <View style={[s.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ headerShown: false }} />
    <ScrollView contentContainerStyle={[s.content, { paddingTop: top + spacing.md }]}>
      <View style={s.header}>
        <Pressable accessibilityLabel="返回" hitSlop={10} onPress={() => router.back()} style={[s.back, { backgroundColor: colors.surfaceSecondary }]}><Ionicons name="arrow-back" size={20} color={colors.textPrimary} /></Pressable>
        <View><AppText style={[s.title, { color: colors.textPrimary }]}>充电详情</AppText><AppText style={[s.subtitle, { color: colors.textMuted }]}>仅显示当前接口返回的数据</AppText></View>
      </View>
      {loading ? <Card><AppText style={{ color: colors.textMuted }}>正在加载…</AppText></Card> : error ? <Card><AppText style={{ color: colors.danger }}>{error}</AppText></Card> : !event ? <Card><AppText style={{ color: colors.textMuted }}>未找到这次充电记录</AppText></Card> : <Card style={s.card}>
        <View style={s.eventHeading}><View style={[s.eventIcon, { backgroundColor: event.is_full_charge ? colors.successSoft : colors.surfaceSecondary }]}><Ionicons name="flash" size={20} color={event.is_full_charge ? colors.success : colors.primary} /></View><View style={{ flex: 1 }}><AppText style={[s.eventTitle, { color: colors.textPrimary }]}>{event.is_full_charge ? '完整充电事件' : '充电事件'}</AppText><AppText style={[s.eventMeta, { color: colors.textMuted }]}>{fmtDate(event.started_at)}</AppText></View></View>
        <View style={[s.rows, { borderTopColor: colors.borderSubtle }]}>{rows.map(([label, value]) => <DetailRow key={label} label={label} value={value} colors={colors} />)}</View>
      </Card>}
    </ScrollView>
  </View>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, content: { paddingHorizontal: spacing.lg, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xl },
  back: { width: 40, height: 40, borderRadius: radius.full, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: fontSize.xxl, fontWeight: '800' }, subtitle: { fontSize: fontSize.xs, marginTop: 2 },
  card: { padding: spacing.lg }, eventHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  eventIcon: { width: 44, height: 44, borderRadius: radius.lg, justifyContent: 'center', alignItems: 'center' }, eventTitle: { fontSize: fontSize.lg, fontWeight: '800' }, eventMeta: { fontSize: fontSize.xs, marginTop: 3, fontFamily: fontMono },
  rows: { borderTopWidth: 1 }, detailRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, borderBottomWidth: 1 }, detailLabel: { fontSize: fontSize.sm }, detailValue: { flex: 1, textAlign: 'right', fontSize: fontSize.sm, fontWeight: '700', fontFamily: fontMono },
});
