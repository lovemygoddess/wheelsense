import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText } from './AppText';
import { ProgressRing, socRampColor, socRampText } from './ProgressRing';
import { colors, fontMono, fontSize, radius, shadow, spacing } from '../theme';
import type { PrimaryTelemetry } from '../types';
import { useAppTheme } from '../ThemeProvider';

function ageText(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 60) return '刚刚更新';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function sourceText(primary: PrimaryTelemetry | undefined): string {
  switch (primary?.source) {
    case 'bms':
      return primary.source_detail === 'phone' ? '保护板 · 本机蓝牙' : '保护板 · 中继';
    case 'voltage': return '电压估算';
    case 'vendor': return '车机参考';
    default: return '等待数据';
  }
}

function qualityText(primary: PrimaryTelemetry | undefined): string {
  if (!primary) return '暂无数据';
  if (primary.quality === 'live') return '实时可信';
  if (primary.quality === 'cached') return '短时缓存';
  if (primary.quality === 'estimated') return '降级估算';
  if (primary.quality === 'reference_only') return '仅供参考';
  return '暂无数据';
}

/**
 * Shared hero used on Home and Battery. Keeping this presentation in one
 * component makes an accidental second SOC/range decision visibly harder.
 */
export function PrimaryEnergyCard({
  primary,
  charging = false,
  onPress,
  compact = false,
  showRange = true,
  variant = 'ring',
}: {
  primary: PrimaryTelemetry | undefined;
  charging?: boolean;
  onPress?: () => void;
  compact?: boolean;
  showRange?: boolean;
  variant?: 'ring' | 'energy-bar';
}) {
  const { colors: c } = useAppTheme();
  const pct = primary?.soc_pct == null ? null : Math.round(primary.soc_pct);
  const range = primary?.range_km ?? null;
  const color = socRampColor(pct);
  const source = sourceText(primary);
  const freshness = primary?.source === 'bms' && !primary.fresh
    ? `${source} · ${ageText(primary.age_seconds)}`
    : source;

  return (
    <Pressable disabled={!onPress} onPress={onPress} style={({ pressed }) => [s.card, { backgroundColor: c.surface, borderColor: c.borderSubtle }, compact && s.compact, pressed && { opacity: 0.86 }]}>
      <View style={[s.topGlow, { backgroundColor: c.primary }]} />
      <View style={s.header}>
        <View style={s.kicker}>
          <Ionicons name={charging ? 'flash' : 'battery-charging-outline'} size={13} color={charging ? colors.accentAmber : colors.accentGreen} />
          <AppText style={s.kickerText}>{charging ? '正在充电' : '当前可用电量'}</AppText>
        </View>
        <View style={[s.sourcePill, primary?.source === 'bms' && primary.fresh && s.sourcePillLive]}>
          <View style={[s.sourceDot, { backgroundColor: primary?.fresh ? colors.success : colors.textMuted }]} />
          <AppText style={[s.sourcePillText, primary?.fresh && { color: colors.success }]} numberOfLines={1}>{freshness}</AppText>
        </View>
      </View>

      <View style={[s.content, variant === 'energy-bar' && s.barContent, !showRange && s.contentSocOnly]}>
        {variant === 'ring' ? <ProgressRing size={compact ? 96 : 112} strokeWidth={compact ? 9 : 10} progress={pct == null ? null : pct / 100} color={color} glow useSocColor>
          <AppText maxFontSizeMultiplier={1.4} style={[s.pct, { color: socRampText(pct), fontSize: compact ? 26 : 31 }]}>{pct == null ? '--' : `${pct}%`}</AppText>
          <AppText style={s.pctLabel}>SOC</AppText>
        </ProgressRing> : <View style={s.energyBlock}>
          <AppText style={[s.energyLabel, { color: c.textSecondary }]}>电量</AppText>
          <AppText maxFontSizeMultiplier={1.35} style={[s.energyNumber, { color: c.textPrimary }]}>{pct == null ? '--' : `${pct}%`}</AppText>
          <View style={[s.energyShell, { backgroundColor: c.surfaceSecondary, borderColor: c.border }]}>
            <View style={[s.energyFill, { width: `${pct ?? 0}%`, backgroundColor: c.primary }]} />
          </View>
        </View>}
        {showRange && <View style={s.rangeBlock}>
          <AppText style={s.rangeLabel}>剩余里程</AppText>
          <View style={s.rangeNumberRow}>
            <AppText maxFontSizeMultiplier={1.35} style={[s.rangeNumber, variant === 'energy-bar' && s.rangeNumberEqual, { color: c.textPrimary }, range == null && s.rangeEmpty]}>{range == null ? '--' : range.toFixed(1)}</AppText>
            <AppText style={s.rangeUnit}>km</AppText>
          </View>
          <AppText style={s.rangeNote} numberOfLines={2}>
            {range == null
              ? (primary?.source === 'vendor' ? '车机数据仅供参考，等待电压或保护板数据' : '等待容量与能耗校准数据')
              : '按同一 SOC × 已校准容量 ÷ 当前能耗计算'}
          </AppText>
        </View>}
      </View>

      <View style={[s.footer, { borderTopColor: c.borderSubtle }]}>
        <Ionicons name={primary?.fresh ? 'checkmark-circle' : 'time-outline'} size={13} color={primary?.fresh ? colors.success : colors.textMuted} />
        <AppText style={s.footerText}>{qualityText(primary)} · {ageText(primary?.age_seconds ?? null) || '暂无更新时间'}</AppText>
        {onPress && <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={{ marginLeft: 'auto' }} />}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: { overflow: 'hidden', backgroundColor: colors.card, borderColor: colors.borderLight, borderWidth: 1, borderRadius: radius.xl, padding: spacing.lg, ...shadow.card },
  compact: { padding: spacing.sm },
  topGlow: { position: 'absolute', width: 240, height: 120, right: -72, top: -84, borderRadius: 120, opacity: 0.13 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, justifyContent: 'space-between' },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  kickerText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  sourcePill: { maxWidth: '63%', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.cardAlt, borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 4 },
  sourcePillLive: { backgroundColor: colors.successLight },
  sourceDot: { width: 6, height: 6, borderRadius: 3 },
  sourcePillText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '600' },
  content: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md, marginBottom: spacing.sm },
  contentSocOnly: { justifyContent: 'center', paddingVertical: spacing.sm },
  barContent: { alignItems: 'stretch', paddingVertical: spacing.sm },
  energyBlock: { flex: 1, minWidth: 0 },
  energyLabel: { fontSize: fontSize.sm, fontWeight: '600' },
  energyNumber: { fontSize: 36, fontWeight: '800', fontFamily: fontMono, letterSpacing: -1.5, marginTop: 2 },
  energyShell: { height: 13, padding: 2, borderWidth: 1, borderRadius: 7, marginTop: 7, overflow: 'hidden' },
  energyFill: { height: 7, borderRadius: 4 },
  pct: { fontFamily: fontMono, fontWeight: '800', letterSpacing: -1 },
  pctLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', marginTop: -2 },
  rangeBlock: { flex: 1, minWidth: 0 },
  rangeLabel: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  rangeNumberRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 2 },
  rangeNumber: { color: colors.text, fontFamily: fontMono, fontSize: 38, fontWeight: '800', letterSpacing: -2 },
  rangeEmpty: { color: colors.textMuted },
  rangeNumberEqual: { fontSize: 36 },
  rangeUnit: { marginLeft: 4, color: colors.textMuted, fontSize: fontSize.md, fontWeight: '700' },
  rangeNote: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
  footer: { borderTopWidth: 1, borderTopColor: colors.borderLight, paddingTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: 5 },
  footerText: { color: colors.textMuted, fontSize: fontSize.xs },
});
