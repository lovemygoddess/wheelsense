/**
 * MetricTile — unified data readout cell.
 *
 * Replaces the per-screen ParamBlock / HealthBlock / DataTile / ReadOnlyField
 * duplicates with one predictable component:
 *   value (big, mono-aligned) over label (muted), optional accent color +
 *   optional trailing unit. Used in dashboard params, battery health grid,
 *   BMS data grid, ride-detail hero, etc.
 */
import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontMono, fontSize, radius, shadow, spacing } from '../theme';
import { useCountUp } from '../hooks/useStagger';
import { InfoHint } from './InfoHint';
import { type HintKey } from '../valueHints';
import { useAppTheme } from '../ThemeProvider';

export function MetricTile({
  value,
  num,
  decimals = 0,
  label,
  unit,
  accent,
  icon,
  mono = true,
  hintKey,
  style,
}: {
  value?: string;
  /** 传数值即启用滚动动画；为 null/undefined 时回退到 value 字符串。 */
  num?: number | null;
  decimals?: number;
  label: string;
  unit?: string;
  accent?: string;
  /** Small Ionicons glyph shown next to the label for quick visual scanning. */
  icon?: keyof typeof Ionicons.glyphMap;
  mono?: boolean;
  /** 数值说明键：在标签右侧自动渲染一个 ⓘ 按钮，点开看解释。 */
  hintKey?: HintKey;
  style?: ViewStyle;
}) {
  const { colors: c } = useAppTheme();
  const counted = useCountUp(num, decimals, 700);
  return (
    <View style={[styles.tile, style]}>
      <View style={styles.valueRow}>
        <AppText maxFontSizeMultiplier={1.4} style={[styles.value, { color: c.textPrimary }, mono && styles.mono, accent ? { color: accent } : null]} numberOfLines={1}>
          {counted ?? value ?? '--'}
        </AppText>
        {unit ? <AppText maxFontSizeMultiplier={1.4} style={[styles.unit, { color: c.textMuted }]}>{unit}</AppText> : null}
      </View>
      <View style={styles.labelRow}>
        {icon ? <Ionicons name={icon} size={11} color={accent ?? c.textMuted} style={{ marginRight: 3 }} /> : null}
        <AppText style={[styles.label, { color: c.textMuted }]} numberOfLines={1}>{label}</AppText>
        {hintKey ? <InfoHint hintKey={hintKey} size={12} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  value: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text, letterSpacing: -0.3 },
  mono: { fontFamily: fontMono },
  unit: { fontSize: fontSize.xs, color: colors.textMuted, marginLeft: 1 },
  labelRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  label: { fontSize: fontSize.xs, color: colors.textMuted, letterSpacing: 0.3 },
});

/** Compact stat badge — big number over label with an accent dot (rides stats). */
export function StatBadge({
  value,
  num,
  decimals = 0,
  label,
  unit,
  accent,
  hintKey,
  style,
}: {
  value?: string;
  /** 传数值即启用滚动动画；为 null/undefined 时回退到 value 字符串。 */
  num?: number | null;
  decimals?: number;
  label: string;
  /** 单位以小字显示在数字右侧（如 Wh / Wh/km）。 */
  unit?: string;
  accent: string;
  hintKey?: HintKey;
  style?: ViewStyle;
}) {
  const counted = useCountUp(num, decimals, 700);
  return (
    <View style={[statStyles.statCard, style]}>
      <View style={[statStyles.statDot, { backgroundColor: accent }]} />
      <View style={statStyles.statValueRow}>
        <AppText style={[statStyles.statValue, { color: accent }]} numberOfLines={1} ellipsizeMode="tail">{counted ?? value ?? '--'}</AppText>
        {unit ? <AppText style={statStyles.statUnit}>{unit}</AppText> : null}
      </View>
      <View style={statStyles.statLabelRow}>
        <AppText style={statStyles.statLabel}>{label}</AppText>
        {hintKey ? <InfoHint hintKey={hintKey} size={11} /> : null}
      </View>
    </View>
  );
}

const statStyles = StyleSheet.create({
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    overflow: 'hidden',
    ...shadow.subtle,
  },
  statDot: { width: 8, height: 8, borderRadius: 4, marginBottom: spacing.xs },
  statValue: { fontSize: fontSize.xl, fontWeight: '700', fontFamily: fontMono, width: '100%', textAlign: 'center' },
  statValueRow: { flexDirection: 'column', alignItems: 'center', width: '100%' },
  statUnit: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1, textAlign: 'center' },
  statLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  statLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 },
});
