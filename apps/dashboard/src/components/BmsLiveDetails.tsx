import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { AppText } from './AppText';
import { Grid } from './Grid';
import { InfoHint } from './InfoHint';
import { colors, fontMono, fontSize, radius, spacing } from '../theme';

/**
 * 保护板实时详情（单体平衡 + 逐探头温度）。
 *
 * 原本在「仪表板」页平铺两张卡，2026-08 起迁移到「电池」页的可折叠卡片里
 * （默认折叠）：骑行中没人逐条盯 14 个单体，但排查压差/探头异常时又要能
 * 展开看全量。数据来自中继实时帧（RelayBmsFrame.cells_mv / temps_c）。
 */

// CALB NMC 14S high-voltage pack: full = 60.9V → 4.35 V/cell.
const CELL_BAR_MIN_MV = 3000;
const CELL_BAR_MAX_MV = 4400;
const CELL_OVER_MV = 4350;

export function CellBar({ index, mv }: { index: number; mv: number | null }) {
  const ratio = mv != null
    ? Math.max(0, Math.min(1, (mv - CELL_BAR_MIN_MV) / (CELL_BAR_MAX_MV - CELL_BAR_MIN_MV)))
    : 0;
  const barColor = mv != null
    ? mv < 3300 ? colors.danger
    : mv > CELL_OVER_MV ? colors.warning
    : colors.primary
    : colors.border;
  const w = useRef(new Animated.Value(0)).current;
  const first = useRef(true);
  useEffect(() => {
    const delay = first.current ? Math.min(index, 13) * 28 : 0;
    const duration = first.current ? 620 : 0;
    first.current = false;
    if (duration === 0) {
      w.setValue(ratio);
      return;
    }
    const t = Animated.timing(w, {
      toValue: ratio, duration, delay, useNativeDriver: false, easing: Easing.out(Easing.cubic),
    });
    t.start();
    return () => t.stop();
  }, [ratio, index, w]);
  return (
    <View style={s.cellBarRow}>
      <AppText style={s.cellBarLabel}>#{index + 1}</AppText>
      <View style={s.cellBarTrack}>
        <Animated.View style={[
          s.cellBarFill,
          { width: w.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }), backgroundColor: barColor },
        ]} />
      </View>
      <AppText style={[s.cellBarValue, mv != null && mv < 3300 && { color: colors.danger }, mv != null && mv > CELL_OVER_MV && { color: colors.warning }]}>
        {mv ?? '--'}
      </AppText>
    </View>
  );
}

function SummaryChip({ label, num, unit, color, highlight }: { label: string; num: number | null; unit: string; color: string; highlight?: boolean }) {
  return (
    <View style={[s.chip, highlight && { borderColor: color }]}>
      <AppText style={s.chipLabel}>{label}</AppText>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 2 }}>
        <AppText style={[s.chipValue, { color }]}>{num ?? '--'}</AppText>
        <AppText style={[s.chipUnit, { color }]}>{unit}</AppText>
      </View>
    </View>
  );
}

/** 单体平衡汇总 + 14 条单体电压条。 */
export function CellBalanceSection({ cellsMv }: { cellsMv: (number | null)[] }) {
  const valid = cellsMv.filter((v): v is number => v != null);
  const maxCell = valid.length > 0 ? Math.max(...valid) : null;
  const minCell = valid.length > 0 ? Math.min(...valid) : null;
  const deltaMv = maxCell != null && minCell != null ? maxCell - minCell : null;
  const deltaColor = deltaMv != null
    ? deltaMv < 20 ? colors.success
    : deltaMv < 50 ? colors.warning
    : colors.danger
    : colors.textMuted;

  return (
    <View>
      <View style={s.sectionTitleRow}>
        <AppText style={s.sectionTitle}>单体平衡 · 压差</AppText>
        <InfoHint hintKey="bms_cell" size={12} />
      </View>
      <View style={s.cellSummaryRow}>
        <SummaryChip label="最高" num={maxCell} unit="mV" color={colors.success} />
        <SummaryChip label="最低" num={minCell} unit="mV" color={colors.warning} />
        <SummaryChip label="压差" num={deltaMv} unit="mV" color={deltaColor} highlight />
      </View>
      <View style={s.cellBarList}>
        {cellsMv.map((mv, i) => <CellBar key={i} index={i} mv={mv} />)}
      </View>
    </View>
  );
}

/** Protection-board counters that are useful for diagnosis but should never
 * be mistaken for the app's learned battery-health model. */
export function BoardCapacitySection({
  totalAh,
  remainingAh,
  sohPct,
}: {
  totalAh: number | null;
  remainingAh: number | null;
  sohPct: number | null;
}) {
  const usable = totalAh != null && totalAh > 0 && remainingAh != null;
  const remainingPct = usable
    ? Math.max(0, Math.min(100, (remainingAh! / totalAh!) * 100))
    : null;

  return (
    <View style={s.boardSection}>
      <View style={s.sectionTitleRow}>
        <AppText style={s.sectionTitle}>保护板库仑计量</AppText>
        <InfoHint hintKey="bms_soc" size={12} />
      </View>
      <View style={s.cellSummaryRow}>
        <SummaryChip label="剩余容量" num={remainingAh} unit="Ah" color={colors.primary} highlight />
        <SummaryChip label="板端配置" num={totalAh} unit="Ah" color={colors.textSecondary} />
        <SummaryChip label="库仑余量" num={remainingPct != null ? Math.round(remainingPct) : null} unit="%" color={colors.accentGreen} />
      </View>
      {sohPct != null && (
        <AppText style={s.boardNote}>板端 SOH {sohPct.toFixed(0)}%：该值由保护板固件上报，仅作板端状态参考；电池健康仍以本页校准结果为准。</AppText>
      )}
    </View>
  );
}

/** 逐探头温度（末两个探头在 ANT 板上是 MOS / 均衡温度）。 */
export function TempProbesSection({ tempsC }: { tempsC: (number | null)[] }) {
  const valid = tempsC.filter((t): t is number => t != null);
  const maxT = valid.length > 0 ? Math.max(...valid) : null;
  const minT = valid.length > 0 ? Math.min(...valid) : null;
  const delta = maxT != null && minT != null ? maxT - minT : null;

  return (
    <View>
      <View style={s.sectionTitleRow}>
        <AppText style={s.sectionTitle}>实时温度</AppText>
        <InfoHint hintKey="bms_temp" size={12} />
        {delta != null && delta > 5 && (
          <View style={[s.pill, { backgroundColor: colors.warningLight }]}>
            <AppText style={[s.pillText, { color: colors.accentAmber }]}>温差 {delta.toFixed(1)}°C</AppText>
          </View>
        )}
      </View>
      <Grid cols={Math.min(Math.max(tempsC.length, 1), 4)} gap={spacing.sm}>
        {tempsC.map((t, i) => {
          const isHot = t != null && t > 50;
          const isCold = t != null && t < 0;
          const tColor = isHot ? colors.danger : isCold ? colors.info : colors.text;
          const tBg = isHot ? colors.dangerLight : isCold ? colors.infoLight : colors.cardAlt;
          const label = tempsC.length >= 3 && i === tempsC.length - 2 ? 'MOS 温度'
            : tempsC.length >= 3 && i === tempsC.length - 1 ? '均衡温度'
            : `探头 ${i + 1}`;
          return (
            <View key={i} style={[s.tempBox, { backgroundColor: tBg }]}>
              <AppText style={s.tempLabel}>{label}</AppText>
              <AppText style={[s.tempValue, { color: tColor }]}>{t != null ? `${t.toFixed(1)}°C` : '--'}</AppText>
            </View>
          );
        })}
      </Grid>
    </View>
  );
}

const s = StyleSheet.create({
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm, marginBottom: spacing.xs },
  sectionTitle: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textSecondary },
  pill: { borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 2, marginLeft: 'auto' },
  pillText: { fontSize: fontSize.xs, fontWeight: '600' },

  cellSummaryRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  chip: { flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.lg, padding: spacing.sm, borderWidth: 1, borderColor: 'transparent' },
  chipLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 2 },
  chipValue: { fontSize: fontSize.lg, fontWeight: '700', fontFamily: fontMono },
  chipUnit: { fontSize: fontSize.xs, color: colors.textMuted },

  cellBarList: { gap: 4 },
  cellBarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cellBarLabel: { width: 26, fontSize: fontSize.xs, color: colors.textMuted, fontFamily: fontMono },
  cellBarTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.borderLight, overflow: 'hidden' },
  cellBarFill: { height: 8, borderRadius: 4 },
  cellBarValue: { width: 44, textAlign: 'right', fontSize: fontSize.xs, color: colors.text, fontFamily: fontMono },

  boardSection: { marginTop: spacing.md },
  boardNote: { marginTop: 2, color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 18 },

  tempBox: { borderRadius: radius.lg, padding: spacing.sm },
  tempLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 2 },
  tempValue: { fontSize: fontSize.md, fontWeight: '700', fontFamily: fontMono },
});
