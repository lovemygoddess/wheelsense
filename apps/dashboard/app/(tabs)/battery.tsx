import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { AppText } from '../../src/components/AppText';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../src/auth';
import { fetchBatteryOverview } from '../../src/api';
import { getTempWarnC, getTempDangerC } from '../../src/widgetData';
import { EmptyState } from '../../src/components/EmptyState';
import { Card } from '../../src/components/Card';
import { SectionHeader } from '../../src/components/SectionHeader';
import { useHeaderTheme } from '../../src/hooks/useHeaderTheme';
import { useStagger, enterStyle, useReveal, revealStyle, spinStyle } from '../../src/hooks/useStagger';
import { Pulse, PressScale } from '../../src/components/Motion';
import { InfoRow } from '../../src/components/InfoRow';
import { InfoHint, useInfoHint } from '../../src/components/InfoHint';
import { type HintKey } from '../../src/valueHints';
import { Skeleton, useShimmer } from '../../src/components/Skeleton';
import { BoardCapacitySection, CellBalanceSection, TempProbesSection } from '../../src/components/BmsLiveDetails';
import { useResponsive } from '../../src/hooks/useResponsive';
import { colors, fontMono, fontSize, headerThemes, radius, shadow, spacing, tint } from '../../src/theme';
import { useAppTheme } from '../../src/ThemeProvider';
import type { BatteryOverview, ChargeEventRow, ChargeTimeEstimate, PrimaryTelemetry, RelayBmsFrame, RelayStatus, VoltageSeriesPoint } from '../../src/types';
import { useVehicleData } from '../../src/vehicleData';

// 电池页不重复首页的电量与续航，聚焦电压、温度、压差、充电和电芯健康。
// 保护板电压、温度、压差和功率来自全局 5s 中继轮询；历史与校准仍按 60s 慢刷新。

function fmtDt(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtAge(iso: string | null, now: number): string {
  if (!iso) return '未知';
  const diff = now - new Date(iso).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function fmtVolts(v: number | null | undefined): string {
  return v === null || v === undefined ? '--' : `${v.toFixed(1)}V`;
}

export default function BatteryScreen() {
  const { unlocked } = useAuth();
  const router = useRouter();
  const { top } = useHeaderTheme(headerThemes.battery);
  const rs = useResponsive();
  const { colors: themeColors } = useAppTheme();
  const openInfoHint = useInfoHint();
  const { selectedSn: deviceSn, relay: relayStatus, refreshSnapshot, refreshRelay } = useVehicleData();
  const [overview, setOverview] = useState<BatteryOverview | null>(null);
  const [loading, setLoading] = useState(false);
  // 顶部 spinner 只跟随手动下拉手势；自动/首载走 loading 脉冲，避免双加载指示。
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tempWarnC, setTempWarnC] = useState(40);
  const [tempDangerC, setTempDangerC] = useState(45);
  const [windowHours, setWindowHours] = useState<24 | 168>(24);
  // 保护板实时详情（单体/温度）折叠状态——默认折叠。
  const [bmsDetailOpen, setBmsDetailOpen] = useState(false);
  const [trendOpen, setTrendOpen] = useState(false);
  const [chargeHistoryOpen, setChargeHistoryOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const bmsDetailReveal = useReveal(bmsDetailOpen);
  // R5: monotonic request sequence (same pattern as the dashboard) — the
  // 60s silent refetch can overlap a manual refresh, and the slower one
  // must not win the write.
  const loadSeqRef = useRef(0);
  const cardAnims = useStagger(5);
  // 读取温度阈值偏好（与首页/通知一致）。
  useEffect(() => {
    (async () => {
      setTempWarnC(await getTempWarnC());
      setTempDangerC(await getTempDangerC());
    })();
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!unlocked) return;
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;
    try {
      if (!silent) setLoading(true);
      setError(null);
      if (!deviceSn) return;
      // `/vehicles` is intentionally a lightweight cached identity list.
      // Refresh the one selected vehicle before deriving battery history and
      // estimates, rather than triggering status+battery reads for every tab.
      await Promise.all([refreshSnapshot(), refreshRelay()]);
      if (!isCurrent()) return;
      const ov = await fetchBatteryOverview(deviceSn, windowHours);
      if (!isCurrent()) return;
      setOverview(ov);
    } catch (e) { if (isCurrent()) setError(e instanceof Error ? e.message : '加载失败'); }
    finally { if (isCurrent()) setLoading(false); }
  }, [unlocked, deviceSn, refreshSnapshot, refreshRelay, windowHours]);

  // 手动下拉：只驱动 refreshing spinner，不触发 loading 脉冲（silent 模式）。
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(true); } finally { setRefreshing(false); }
  }, [load]);

  useFocusEffect(useCallback(() => {
    load();
    const clock = setInterval(() => setNow(Date.now()), 30000);
    const refetch = setInterval(() => load(true), 60000);
    return () => { clearInterval(clock); clearInterval(refetch); };
  }, [load]));

  const o = overview;
  const latest = o?.latest ?? null;
  const cal = o?.calibration ?? null;
  const voltage = latest?.bms_voltage ?? null;
  const temp = latest?.batt_temp ?? null;
  const bmsScore = latest?.bms_score ?? null;
  const bmsCycles = latest?.bms_cycles ?? null;
  const isCharging = o?.is_charging ?? false;
  const ageLabel = fmtAge(o?.primary.updated_at ?? o?.latest_at ?? null, now);

  // 中继实时板数据优先：当中继在线且刚上报真实 BMS 帧时，充电电流/功率改用
  // 中继实测值；否则回落后端估算（charge_power_w / charge_current_effective_a）。
  // 两个值都必须门控 isCharging：停车时板子有 ~0.1A 的自耗电/均衡微电流，
  // 未门控时偏差 = (设定 8A − 0.1A)/0.1A ≈ +7900%，曾经真的显示出来过。
  const relayBms = relayStatus?.bms ?? o?.relay ?? null;
  const relayFresh = relayStatus != null
    ? relayStatus.board_state === 'live' && relayBms?.fresh === true
    : relayBms?.fresh === true;
  const relayPowerW = relayFresh && isCharging && relayBms?.power_w != null ? Math.abs(relayBms.power_w) : null;
  const relayCurrentA = relayFresh && isCharging && relayBms?.current_a != null ? Math.abs(relayBms.current_a) : null;

  // 顶部电压/温度：中继实时帧比 REST 快照（≤60s 旧）更新鲜时直接用实测值。
  const liveVoltage = relayFresh && relayBms?.total_voltage_v != null ? relayBms.total_voltage_v : null;
  const liveTemps = relayFresh && relayBms?.temps_c != null
    ? relayBms.temps_c.filter((t): t is number => t != null)
    : [];
  const liveTempMax = liveTemps.length > 0 ? Math.max(...liveTemps) : null;
  const validCells = (relayBms?.cells_mv ?? []).filter((v): v is number => v != null);
  const cellDeltaMv = validCells.length > 1 ? Math.max(...validCells) - Math.min(...validCells) : null;

  const cycleLabel = cal?.effective_cycle_count != null
    ? `${cal.effective_cycle_count}`
    : bmsCycles != null ? `${bmsCycles}` : null;

  const bmsFull = cal?.bms_full_charge_voltage ?? 60.9;
  const health = buildBatteryHealth({
    relayStatus,
    relayBms,
    relayFresh,
    voltage: liveVoltage ?? voltage,
    temp: liveTempMax ?? temp,
    cellDeltaMv: relayFresh ? cellDeltaMv : null,
    cutoffVoltage: cal?.bms_cutoff_voltage ?? 42,
    tempWarnC,
    tempDangerC,
  });
  const headlineStatusColor = health.tone === 'danger' ? colors.danger
    : health.tone === 'warning' || !relayFresh ? colors.warning
      : colors.success;

  return (
    <ScrollView style={[s.container, { backgroundColor: themeColors.background }]} contentContainerStyle={{ paddingHorizontal: rs.pagePad, paddingTop: top, paddingBottom: spacing.xxl }} refreshControl={<RefreshControl tintColor={themeColors.primary} refreshing={refreshing} onRefresh={onRefresh} />}>
      {error && !o && (
        <EmptyState
          variant="float"
          icon="alert-circle-outline"
          title="加载失败"
          subtitle={error}
          accent={colors.danger}
          accentBg={colors.dangerLight}
          actionLabel="重试"
          onAction={() => load()}
        />
      )}

      {!o && !error && loading && (
        <BatterySkeleton />
      )}
      {!o && !loading && !error && (
        <EmptyState
          variant="float"
          icon="battery-dead-outline"
          title="暂无电池数据"
          subtitle="请先在设置页绑定车辆，并等待首次轮询完成"
          accent={colors.textSecondary}
          accentBg={colors.cardAlt}
        />
      )}

      {/* R5: with stale data on screen a failed refresh used to be completely
          silent — surface a dismissible-looking banner like the dashboard's. */}
      {error && o != null && (
        <View style={[s.errorCard, { backgroundColor: themeColors.dangerSoft, borderColor: themeColors.danger }]}>
          <Ionicons name="alert-circle-outline" size={16} color={themeColors.danger} />
          <AppText style={[s.errorText, { color: themeColors.danger }]}>{error}</AppText>
        </View>
      )}

      {o && (
        <>
          <Animated.View style={enterStyle(cardAnims[0])}>
            <View style={s.deviceHeader}>
              <View style={[s.deviceIcon, { backgroundColor: isCharging ? themeColors.warningSoft : themeColors.surface }]}>
                <Pulse active={isCharging} minOpacity={0.5} scaleTo={1.14}>
                  <Ionicons name={isCharging ? 'flash' : 'battery-half'} size={20} color={isCharging ? colors.accentAmber : colors.primary} />
                </Pulse>
              </View>
              <View style={{ flex: 1 }}>
                <View style={s.deviceTitleRow}>
                  <AppText style={[s.deviceName, { color: themeColors.textPrimary }]}>{o.device.name}</AppText>
                  <View style={[s.headlineStatusDot, { backgroundColor: headlineStatusColor }]} />
                  <AppText style={[s.headlineStatusText, { color: headlineStatusColor }]}>{relayFresh ? '实时' : '历史数据'}</AppText>
                  <AppText style={[s.deviceSn, { color: themeColors.textMuted }]}>SN {o.device.sn.slice(-4)}</AppText>
                </View>
                <AppText style={[s.deviceMeta, { color: themeColors.textMuted }]}>{isCharging ? '正在补充能量' : '电池状态一目了然'}</AppText>
              </View>
              <PressScale onPress={() => load()} hitSlop={8} min={0.88} style={({ pressed }) => [s.refreshBtn, { backgroundColor: themeColors.surfaceSecondary }, pressed && { opacity: 0.6 }]}>
                <Ionicons name="refresh-outline" size={18} color={themeColors.textMuted} />
              </PressScale>
            </View>
            <BatteryHealthStrip health={health} />
          </Animated.View>

          <Animated.View style={enterStyle(cardAnims[1])}>
            <Card style={s.cardSpacing}>
              <SectionHeader icon="sparkles-outline" title="关键状态" badge={relayFresh ? '实时' : '最近数据'} badgeTone={relayFresh ? 'emerald' : 'gray'} />
              <View style={[s.safetyGrid, { gap: rs.gridGap }]}>
                <SafetyMetric label="电池电压" value={fmtVolts(liveVoltage ?? voltage)} note={liveVoltage != null ? '保护板实测' : '最近一次记录'} tone={health.voltageTone} hintKey="voltage_b" />
                <SafetyMetric label="最高温度" value={(liveTempMax ?? temp) != null ? `${(liveTempMax ?? temp)!.toFixed(1)}°C` : '--'} note={liveTempMax != null ? '当前最高探头' : '最近一次记录'} tone={health.tempTone} hintKey="battery_temp" />
                <SafetyMetric label="单体平衡" value={relayFresh && cellDeltaMv != null ? `${cellDeltaMv}mV` : '--'} note={relayFresh ? '压差越小越均衡' : '实时数据不可用'} tone={health.cellTone} hintKey="bms_cell" />
                <SafetyMetric label="电池健康" value={relayBms?.soh_pct != null ? `${Math.round(relayBms.soh_pct)}%` : '--'} note={relayBms?.soh_pct != null ? '保护板参考值' : '等待保护板数据'} tone="neutral" hintKey="bms_soc" />
                <SafetyMetric label="等效循环" value={cycleLabel ?? '--'} note="累计循环容量 ÷ 95Ah" tone="neutral" hintKey="cycle_b" />
              </View>
            </Card>
          </Animated.View>

          {isCharging && (
            <Animated.View style={enterStyle(cardAnims[2])}>
              <Card style={s.cardSpacing}>
                <SectionHeader icon="flash-outline" title="正在充电" badge={o.charge_time_estimate.method === 'bms_capacity' ? '保护板推算' : '估算'} badgeTone={o.charge_time_estimate.method === 'bms_capacity' ? 'emerald' : 'gray'} />
                <ChargingPanel
                  estimate={o.charge_time_estimate}
                  voltage={liveVoltage ?? voltage}
                  bmsFull={bmsFull}
                  powerW={relayPowerW ?? o.charge_power_w}
                  measuredCurrentA={relayCurrentA}
                  configuredCurrentA={o.charge_current_effective_a}
                />
              </Card>
            </Animated.View>
          )}

          {relayBms != null && ((relayBms.cells_mv?.length ?? 0) > 0 || (relayBms.temps_c?.length ?? 0) > 0) && (
            <Animated.View style={enterStyle(cardAnims[3])}>
              <Card style={s.cardSpacing}>
                <Pressable onPress={() => setBmsDetailOpen(v => !v)}>
                  <SectionHeader
                    icon="hardware-chip-outline"
                    title="电芯与温度详情"
                    badge={relayFresh ? '当前' : formatBmsAge(relayStatus, relayBms)}
                    badgeTone={relayFresh ? 'emerald' : 'gray'}
                    style={{ marginBottom: 0 }}
                    accessory={<Animated.View style={spinStyle(bmsDetailReveal)}><Ionicons name="chevron-down" size={16} color={colors.textMuted} /></Animated.View>}
                  />
                  {!bmsDetailOpen && <AppText style={s.foldedHint}>14 串单体、探头温度与容量信息</AppText>}
                </Pressable>
                {bmsDetailOpen && (
                  <Animated.View style={[{ marginTop: spacing.sm }, revealStyle(bmsDetailReveal)]}>
                    {(relayBms.capacity_total_ah != null || relayBms.capacity_remaining_ah != null) && <BoardCapacitySection totalAh={relayBms.capacity_total_ah} remainingAh={relayBms.capacity_remaining_ah} sohPct={relayBms.soh_pct} />}
                    {(relayBms.cells_mv?.length ?? 0) > 0 && <CellBalanceSection cellsMv={relayBms.cells_mv ?? []} />}
                    {(relayBms.temps_c?.length ?? 0) > 0 && <TempProbesSection tempsC={relayBms.temps_c ?? []} />}
                    {!relayFresh && <AppText style={s.bmsDetailStale}>这是最近一次有效保护板帧，不代表当前仍保持连接。</AppText>}
                  </Animated.View>
                )}
              </Card>
            </Animated.View>
          )}

          <Animated.View style={enterStyle(cardAnims[2])}>
            <Card style={s.cardSpacing}>
              <Pressable onPress={() => setTrendOpen(v => !v)}>
                <SectionHeader icon="pulse-outline" title="电压趋势" badge={windowHours === 24 ? '24 小时' : '7 天'} badgeTone="gray" style={{ marginBottom: 0 }} accessory={<Ionicons name={trendOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />} />
                {!trendOpen && <AppText style={s.foldedHint}>查看电压变化与充电区间</AppText>}
              </Pressable>
              {trendOpen && <View style={s.foldedContent}>
                <View style={s.rangeTabs}>
                  {([24, 168] as const).map(hours => (
                    <PressScale key={hours} onPress={() => setWindowHours(hours)} style={[s.rangeTab, windowHours === hours && s.rangeTabActive]}>
                      <AppText style={[s.rangeTabText, windowHours === hours && s.rangeTabTextActive]}>{hours === 24 ? '24 小时' : '7 天'}</AppText>
                    </PressScale>
                  ))}
                </View>
                {o.voltage_series.length === 0 ? <AppText style={s.noDataText}>尚无电压数据</AppText> : <VoltageChart data={o.voltage_series} bmsFull={bmsFull} bmsCutoff={cal?.bms_cutoff_voltage ?? 42} />}
              </View>}
            </Card>
          </Animated.View>

          <Animated.View style={enterStyle(cardAnims[3])}>
            <Card style={s.cardSpacing}>
              <Pressable onPress={() => setChargeHistoryOpen(v => !v)}>
                <SectionHeader icon="time-outline" title="充电记录" badge={`${o.charge_events.length} 次`} badgeTone="gray" style={{ marginBottom: 0 }} accessory={<Ionicons name={chargeHistoryOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />} />
                {!chargeHistoryOpen && <AppText style={s.foldedHint}>查看最近的充电时长与完成情况</AppText>}
              </Pressable>
              {chargeHistoryOpen && <View style={s.foldedContent}>{(o.charge_events ?? []).length === 0 ? <AppText style={s.noDataText}>尚未检测到充电事件</AppText> : (o.charge_events ?? []).slice(0, 10).map((e: ChargeEventRow) => <ChargeEventRowItem key={e.id} e={e} onPress={() => router.push({ pathname: '/charging-detail', params: { id: String(e.id), sn: deviceSn ?? '' } })} />)}</View>}
            </Card>
          </Animated.View>

          <Animated.View style={enterStyle(cardAnims[4])}>
            <Card style={s.cardSpacing}>
              <Pressable onPress={() => setDiagnosticsOpen(v => !v)}>
                <SectionHeader icon="construct-outline" title="高级信息" badge="调试" badgeTone="gray" style={{ marginBottom: 0 }} accessory={<Ionicons name={diagnosticsOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />} />
                {!diagnosticsOpen && <AppText style={s.foldedHint}>数据来源、算法状态与保护板协议信息</AppText>}
              </Pressable>
              {diagnosticsOpen && <View style={s.foldedContent}>
                <Pressable style={s.metricGuide} onPress={() => openInfoHint('battery_metrics_guide')}>
                  <View style={s.metricGuideIcon}><Ionicons name="book-outline" size={17} color={colors.primary} /></View>
                  <View style={{ flex: 1 }}>
                    <AppText style={s.metricGuideTitle}>怎么看电池指标</AppText>
                    <AppText style={s.metricGuideText}>集中查看电压、数据来源与安全判断说明</AppText>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </Pressable>
                <InfoRow label="数据可信度" value={`${Math.round(o.primary.confidence * 100)}%`} />
                <InfoRow label="当前来源" value={primarySourceLabel(o.primary)} />
                <InfoRow label="数据状态" value={o.primary.quality === 'live' ? '实时可信' : o.primary.quality === 'cached' ? '短时缓存' : o.primary.quality === 'estimated' ? '降级估算' : '仅供参考'} />
                <InfoRow label="续航计算" value={o.primary.usable_for_range ? '可用' : '等待可信数据'} />
                <InfoRow label="安全判断" value={o.primary.usable_for_safety ? '实时保护板数据' : '不可用于实时告警'} />
                {relayFresh && relayBms?.battery_status != null ? <InfoRow label="保护板状态" value={['未知', '空闲', '充电', '放电', '待机', '故障'][relayBms.battery_status] ?? `状态 ${relayBms.battery_status}`} /> : null}
                {relayFresh && relayBms?.charge_mosfet_code != null ? <InfoRow label="充电 MOS" value={relayBms.charge_mosfet_code === 1 ? '已开启' : relayBms.charge_mosfet_code === 0 ? '已关闭' : `异常码 ${relayBms.charge_mosfet_code}`} /> : null}
                {relayFresh && relayBms?.discharge_mosfet_code != null ? <InfoRow label="放电 MOS" value={relayBms.discharge_mosfet_code === 1 ? '已开启' : relayBms.discharge_mosfet_code === 0 ? '已关闭' : `异常码 ${relayBms.discharge_mosfet_code}`} /> : null}
                {relayFresh && relayBms?.balancer_code != null ? <InfoRow label="均衡器" value={relayBms.balancer_code === 0 ? '未工作' : relayBms.balancer_code === 1 ? '正在均衡' : `状态码 ${relayBms.balancer_code}`} /> : null}
                <AppText style={s.diagnosticFootnote}>保护板约 5 秒刷新 · 历史数据 60 秒刷新 · {fmtDt(o.generated_at)}</AppText>
              </View>}
            </Card>
          </Animated.View>
        </>
      )}
    </ScrollView>
  );
}

type HealthTone = 'success' | 'warning' | 'danger' | 'neutral';

type BatteryHealth = {
  title: string;
  message: string;
  tone: HealthTone;
  icon: 'checkmark-circle' | 'alert-circle' | 'time-outline' | 'cloud-offline-outline';
  voltageTone: HealthTone;
  tempTone: HealthTone;
  cellTone: HealthTone;
};

function toneColor(tone: HealthTone): string {
  return tone === 'danger' ? colors.danger : tone === 'warning' ? colors.warning : tone === 'success' ? colors.success : colors.textSecondary;
}

function buildBatteryHealth({ relayStatus, relayBms, relayFresh, voltage, temp, cellDeltaMv, cutoffVoltage, tempWarnC, tempDangerC }: {
  relayStatus: RelayStatus | null;
  relayBms: RelayBmsFrame | null;
  relayFresh: boolean;
  voltage: number | null;
  temp: number | null;
  cellDeltaMv: number | null;
  cutoffVoltage: number;
  tempWarnC: number;
  tempDangerC: number;
}): BatteryHealth {
  const voltageTone: HealthTone = voltage != null && voltage <= cutoffVoltage ? 'danger' : 'success';
  const tempTone: HealthTone = temp != null && temp >= tempDangerC ? 'danger' : temp != null && temp >= tempWarnC ? 'warning' : 'success';
  const underLoad = relayBms?.current_a != null && Math.abs(relayBms.current_a) > 3;
  const cellTone: HealthTone = cellDeltaMv == null ? 'neutral' : cellDeltaMv >= 50 ? (underLoad ? 'warning' : 'danger') : cellDeltaMv >= 20 ? 'warning' : 'success';

  if (tempTone === 'danger') return { title: '电池温度过高', message: `最高探头 ${temp?.toFixed(1)}°C，请停止高负载并检查散热`, tone: 'danger', icon: 'alert-circle', voltageTone, tempTone, cellTone };
  if (voltageTone === 'danger') return { title: '电池电压接近欠压', message: `当前 ${voltage?.toFixed(1)}V，建议尽快停止骑行并充电`, tone: 'danger', icon: 'alert-circle', voltageTone, tempTone, cellTone };
  if (cellTone === 'danger') return { title: '单体压差偏大', message: `当前压差 ${cellDeltaMv}mV，静置后仍偏大时建议检查均衡`, tone: 'danger', icon: 'alert-circle', voltageTone, tempTone, cellTone };
  if (tempTone === 'warning' || cellTone === 'warning') return { title: '电池状态需留意', message: tempTone === 'warning' ? `温度已达 ${temp?.toFixed(1)}°C` : underLoad ? `负载中压差 ${cellDeltaMv}mV，静置后再判断均衡` : `单体压差 ${cellDeltaMv}mV`, tone: 'warning', icon: 'alert-circle', voltageTone, tempTone, cellTone };
  if (!relayFresh) {
    const connectedStale = relayStatus?.board_state === 'connected_stale';
    return { title: connectedStale ? '保护板已连接，等待新数据' : '保护板当前未实时同步', message: relayBms ? `最近有效数据 ${formatBmsAge(relayStatus, relayBms)}` : '页面仍使用车辆快照与校准结果', tone: connectedStale ? 'warning' : 'neutral', icon: connectedStale ? 'time-outline' : 'cloud-offline-outline', voltageTone, tempTone, cellTone };
  }
  return { title: '电池状态正常', message: '温度、电压与单体平衡均未发现异常', tone: 'success', icon: 'checkmark-circle', voltageTone, tempTone, cellTone };
}

function primarySourceLabel(primary: PrimaryTelemetry): string {
  if (primary.source === 'bms') return primary.source_detail === 'relay' ? '保护板库仑计量 · 中继' : '保护板库仑计量';
  if (primary.source === 'voltage') return '电压曲线估算';
  if (primary.source === 'vendor') return 'NineCLI 临时兜底';
  return '暂无可靠来源';
}

function BatteryHealthStrip({ health }: { health: BatteryHealth }) {
  const { colors: c } = useAppTheme();
  const color = health.tone === 'danger' ? c.danger : health.tone === 'warning' ? c.warning : health.tone === 'success' ? c.success : c.textSecondary;
  const background = health.tone === 'danger' ? c.dangerSoft : health.tone === 'warning' ? c.warningSoft : health.tone === 'success' ? c.successSoft : c.surfaceSecondary;
  return (
    <View style={[s.healthStrip, { backgroundColor: background }]}>
      <Ionicons name={health.icon} size={20} color={color} />
      <View style={{ flex: 1 }}>
        <AppText style={[s.healthStripTitle, { color }]}>{health.title}</AppText>
        <AppText style={[s.healthStripMessage, { color: c.textSecondary }]}>{health.message}</AppText>
      </View>
    </View>
  );
}

function SafetyMetric({ label, value, note, tone, hintKey }: { label: string; value: string; note: string; tone: HealthTone; hintKey: HintKey }) {
  const { colors: c } = useAppTheme();
  const valueColor = tone === 'danger' ? c.danger : tone === 'warning' ? c.warning : tone === 'success' ? c.success : c.textPrimary;
  return (
    <View style={[s.safetyMetric, { backgroundColor: c.surfaceSecondary }]}>
      <View style={s.safetyMetricLabelRow}><AppText style={[s.safetyMetricLabel, { color: c.textMuted }]}>{label}</AppText><InfoHint hintKey={hintKey} size={11} /></View>
      <AppText style={[s.safetyMetricValue, { color: valueColor }]}>{value}</AppText>
      <AppText style={[s.safetyMetricNote, { color: c.textMuted }]}>{note}</AppText>
    </View>
  );
}

function ChargingPanel({ estimate, voltage, bmsFull, powerW, measuredCurrentA, configuredCurrentA }: {
  estimate: ChargeTimeEstimate;
  voltage: number | null;
  bmsFull: number;
  powerW: number | null;
  measuredCurrentA: number | null;
  configuredCurrentA: number | null;
}) {
  const remaining = estimate.supported && estimate.remaining_min != null ? Math.max(0, Math.round(estimate.remaining_min)) : null;
  const timeLabel = remaining == null ? '--' : remaining === 0 ? '已满' : remaining >= 60 ? `约 ${Math.floor(remaining / 60)}h${remaining % 60}m` : `约 ${remaining}min`;
  const timeNote = remaining == null
    ? estimate.reason ?? '等待可靠数据'
    : estimate.method === 'bms_capacity' && estimate.capacity_to_fill_ah != null
      ? `还需约 ${estimate.capacity_to_fill_ah.toFixed(1)}Ah · 含末段降流`
      : estimate.note ?? (voltage != null ? `${voltage.toFixed(1)} → ${bmsFull.toFixed(1)}V` : '动态估算');
  const deviation = measuredCurrentA != null && configuredCurrentA != null && measuredCurrentA >= 0.3
    ? Math.round((configuredCurrentA - measuredCurrentA) / measuredCurrentA * 100)
    : null;
  return (
    <>
      <View style={s.chargingGrid}>
        <ChargeMetric label="预计充满" value={timeLabel} note={timeNote} />
        <ChargeMetric label="充电功率" value={powerW != null ? `${(powerW / 1000).toFixed(2)}kW` : '--'} note={powerW != null ? '当前实测' : '等待数据'} />
        <ChargeMetric label="充电电流" value={measuredCurrentA != null ? `${measuredCurrentA.toFixed(1)}A` : '--'} note="保护板电流" />
      </View>
      {configuredCurrentA != null && (
        <View style={s.chargeCompareRow}>
          <AppText style={s.chargeCompareText}>设定 {configuredCurrentA.toFixed(1)}A</AppText>
          <View style={s.chargeCompareDivider} />
          <AppText style={[s.chargeCompareText, deviation != null && { color: Math.abs(deviation) > 10 ? colors.danger : Math.abs(deviation) > 5 ? colors.warning : colors.success }]}>
            {deviation == null ? '涓流阶段不计算偏差' : `与实测偏差 ${deviation > 0 ? '+' : ''}${deviation}%`}
          </AppText>
        </View>
      )}
    </>
  );
}

function ChargeMetric({ label, value, note }: { label: string; value: string; note: string }) {
  return <View style={s.chargeMetric}><AppText style={s.chargeMetricLabel}>{label}</AppText><AppText style={s.chargeMetricValue}>{value}</AppText><AppText style={s.chargeMetricNote}>{note}</AppText></View>;
}

function BmsCompactSummary({ frame }: { frame: RelayBmsFrame }) {
  const cells = (frame.cells_mv ?? []).filter((v): v is number => v != null);
  const delta = cells.length > 1 ? Math.max(...cells) - Math.min(...cells) : null;
  const temps = (frame.temps_c ?? []).filter((v): v is number => v != null);
  const hottest = temps.length > 0 ? Math.max(...temps) : null;
  const underLoad = frame.current_a != null && Math.abs(frame.current_a) > 3;
  return (
    <View style={s.bmsCompactRow}>
      <BmsCompactItem label="单体" value={cells.length > 0 ? `${cells.length} 串` : '--'} />
      <BmsCompactItem label="压差" value={delta != null ? `${delta}mV` : '--'} tone={delta != null && delta >= 50 ? (underLoad ? 'warning' : 'danger') : delta != null && delta >= 20 ? 'warning' : 'success'} />
      <BmsCompactItem label="最高温" value={hottest != null ? `${hottest.toFixed(1)}°C` : '--'} tone={hottest != null && hottest >= 45 ? 'danger' : 'success'} />
    </View>
  );
}

function BmsCompactItem({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: HealthTone }) {
  return <View style={s.bmsCompactItem}><AppText style={s.bmsCompactLabel}>{label}</AppText><AppText style={[s.bmsCompactValue, { color: toneColor(tone) }]}>{value}</AppText></View>;
}

function formatBmsAge(relayStatus: RelayStatus | null, frame: RelayBmsFrame): string {
  const seconds = relayStatus?.board_frame_age_seconds ?? frame.age_seconds ?? 0;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒前`;
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} 分钟前`;
  return `${Math.round(seconds / 3600)} 小时前`;
}

function VoltageChart({ data, bmsFull, bmsCutoff }: { data: VoltageSeriesPoint[]; bmsFull: number; bmsCutoff: number }) {
  const { colors: tc } = useAppTheme();
  const [chartWidth, setChartWidth] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const valid = data.filter((p): p is VoltageSeriesPoint & { voltage: number } => p.voltage != null);
  const step = Math.max(1, Math.ceil(valid.length / 32));
  const sampled = valid.filter((_, i) => i % step === 0);
  if (valid.length > 1 && sampled[sampled.length - 1] !== valid[valid.length - 1]) sampled.push(valid[valid.length - 1]);
  const voltages = valid.map(p => p.voltage);
  const rawMax = voltages.length > 0 ? Math.max(...voltages) : bmsFull;
  const rawMin = voltages.length > 0 ? Math.min(...voltages) : bmsCutoff;
  // 至少显示 2V 的纵轴窗口，避免 0.1V 噪声被拉满整张图。
  const displaySpan = Math.max(2, rawMax - rawMin);
  const displayMid = (rawMax + rawMin) / 2;
  const maxV = displayMid + displaySpan / 2;
  const minV = displayMid - displaySpan / 2;
  const midV = displayMid;
  const height = 150;

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
  };
  const firstTime = sampled[0]?.timestamp;
  const midTime = sampled[Math.floor(sampled.length / 2)]?.timestamp;
  const lastTime = sampled[sampled.length - 1]?.timestamp;
  const pickIndex = useCallback((x: number) => {
    if (valid.length === 0 || chartWidth <= 0) return;
    const usable = Math.max(1, chartWidth - 8);
    const idx = Math.round(((x - 4) / usable) * Math.max(1, valid.length - 1));
    setSelectedIndex(Math.min(valid.length - 1, Math.max(0, idx)));
  }, [chartWidth, valid.length]);
  const chartPanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => sampled.length > 0,
    onMoveShouldSetPanResponder: () => sampled.length > 0,
    onPanResponderGrant: event => pickIndex(event.nativeEvent.locationX),
    onPanResponderMove: event => pickIndex(event.nativeEvent.locationX),
  }), [pickIndex, sampled.length]);
  const selected = selectedIndex == null ? null : valid[Math.min(selectedIndex, Math.max(0, valid.length - 1))];
  const selectedX = selected && chartWidth > 0 ? (selectedIndex! / Math.max(1, valid.length - 1)) * (chartWidth - 8) + 4 : 0;
  const selectedY = selected ? 6 + (1 - (selected.voltage - minV) / displaySpan) * (height - 12) : 0;
  const tooltipWidth = 132;
  const tooltipLeft = Math.max(2, Math.min(Math.max(2, chartWidth - tooltipWidth - 2), selectedX - tooltipWidth / 2));

  return (
    <View>
      <View style={s.voltageChartWrap}>
        <View style={s.voltageYAxis}>
          <AppText style={s.voltageYLabel}>{maxV.toFixed(1)}</AppText>
          <AppText style={s.voltageYLabel}>{midV.toFixed(1)}</AppText>
          <AppText style={s.voltageYLabel}>{minV.toFixed(1)}</AppText>
        </View>
        <View {...chartPanResponder.panHandlers} style={s.voltageChartArea} onLayout={(event) => setChartWidth(event.nativeEvent.layout.width)}>
          <View style={[s.voltageGridLine, { top: 0 }]} />
          <View style={[s.voltageGridLine, { top: height * 0.5 }]} />
          <View style={[s.voltageGridLine, { bottom: 0 }]} />
          {chartWidth > 0 && sampled.map((pt, i) => {
            if (i === 0) return null;
            const prev = sampled[i - 1];
            const x1 = ((i - 1) / Math.max(1, sampled.length - 1)) * (chartWidth - 8) + 4;
            const x2 = (i / Math.max(1, sampled.length - 1)) * (chartWidth - 8) + 4;
            const y1 = 6 + (1 - (prev.voltage - minV) / displaySpan) * (height - 12);
            const y2 = 6 + (1 - (pt.voltage - minV) / displaySpan) * (height - 12);
            const dx = x2 - x1;
            const dy = y2 - y1;
            const length = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx);
            return <View key={`line-${i}`} style={[s.voltageLine, { left: (x1 + x2) / 2 - length / 2, top: (y1 + y2) / 2 - 1, width: length, backgroundColor: pt.charging ? tc.warning : tc.primary, transform: [{ rotateZ: `${angle}rad` }] }]} />;
          })}
          {chartWidth > 0 && sampled.map((pt, i) => {
            const x = (i / Math.max(1, sampled.length - 1)) * (chartWidth - 8) + 4;
            const y = 6 + (1 - (pt.voltage - minV) / displaySpan) * (height - 12);
            return <View key={`dot-${i}`} style={[s.voltagePoint, { left: x - 2.5, top: y - 2.5, backgroundColor: pt.charging ? tc.warning : tc.primary, borderColor: tc.surface }]} />;
          })}
          {selected && <>
            <View pointerEvents="none" style={[s.voltageCrosshair, { left: selectedX, backgroundColor: tc.border }]} />
            <View pointerEvents="none" style={[s.voltageSelectedPoint, { left: selectedX - 5, top: selectedY - 5, backgroundColor: selected.charging ? tc.warning : tc.primary, borderColor: tc.surface }]} />
            <View pointerEvents="none" style={[s.voltageTooltip, { left: tooltipLeft, backgroundColor: tc.surface, borderColor: tc.border }]}>
              <AppText style={[s.voltageTooltipTime, { color: tc.textMuted }]}>{fmtDt(selected.timestamp)}</AppText>
              <AppText style={[s.voltageTooltipValue, { color: tc.textPrimary }]}>{selected.voltage.toFixed(2)} V</AppText>
            </View>
          </>}
        </View>
      </View>
      <View style={s.voltageXAxisRow}>
        <AppText style={s.voltageXLabel}>{firstTime ? fmtTime(firstTime) : ''}</AppText>
        <AppText style={s.voltageXLabel}>{midTime ? fmtTime(midTime) : ''}</AppText>
        <AppText style={s.voltageXLabel}>{lastTime ? fmtTime(lastTime) : ''}</AppText>
      </View>
      <View style={s.chartSummaryRow}>
        <AppText style={s.chartDelta}>实际波动 {(rawMax - rawMin).toFixed(2)}V · {valid.length} 个点</AppText>
      </View>
      <View style={s.voltageLegend}>
        <View style={s.voltageLegendItem}>
          <View style={[s.voltageLegendDot, { backgroundColor: colors.primary }]} />
          <AppText style={s.voltageLegendText}>电池电压</AppText>
        </View>
        <View style={s.voltageLegendItem}>
          <View style={[s.voltageLegendDot, { backgroundColor: '#fbbf24' }]} />
          <AppText style={s.voltageLegendText}>充电中</AppText>
        </View>
      </View>
    </View>
  );
}

function ChargeEventRowItem({ e, onPress }: { e: ChargeEventRow; onPress?: () => void }) {
  const duration = formatDuration(e.started_at, e.ended_at);
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [s.chargeEventRow, pressed && { opacity: 0.78 }]}>
      <View style={[s.chargeEventIcon, e.is_full_charge && s.chargeEventIconGreen]}>
        <Ionicons name={e.is_full_charge ? 'flash' : 'battery-half'} size={16} color={e.is_full_charge ? colors.accentGreen : colors.textSecondary} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText style={s.chargeEventTime}>
          {e.started_at ? fmtDt(e.started_at) : '时间未知'}
        </AppText>
        <AppText style={s.chargeEventDetail}>
          {duration} · {fmtVolts(e.start_voltage)} → {fmtVolts(e.end_voltage)} · 峰值 {fmtVolts(e.peak_voltage)}
          {e.avg_temp != null ? ` · ${Math.round(e.avg_temp)}°C` : ''}
        </AppText>
      </View>
      <AppText style={[s.chargeEventBadge, e.is_full_charge && s.chargeEventBadgeGreen]}>
        {e.is_full_charge ? '满电' : '未满'}
      </AppText>
      {onPress && <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />}
    </Pressable>
  );
}

function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return '时长未知';
  if (!endedAt) return '进行中';
  const minutes = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分` : `${minutes}分钟`;
}

/** 首载骨架屏：镜像设备头、能量主卡、安全概览和趋势图。 */
function BatterySkeleton() {
  const shimmer = useShimmer();
  return (
    <View>
      <Card style={s.cardSpacing}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg }}>
          <Skeleton value={shimmer} width={44} height={44} round={radius.lg} />
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Skeleton value={shimmer} width={'50%'} height={16} round={radius.sm} />
            <Skeleton value={shimmer} width={'30%'} height={12} round={radius.sm} />
          </View>
          <Skeleton value={shimmer} width={64} height={26} round={radius.full} />
        </View>
        <Skeleton value={shimmer} height={132} round={radius.xl} />
        <Skeleton value={shimmer} height={58} round={radius.lg} style={{ marginTop: spacing.sm }} />
      </Card>

      <Card style={s.cardSpacing}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {[0, 1, 2, 3].map(i => <Skeleton key={i} value={shimmer} style={{ flexGrow: 1, flexBasis: '46%' }} height={72} round={radius.lg} />)}
        </View>
      </Card>

      <Card style={s.cardSpacing}>
        <Skeleton value={shimmer} height={150} round={radius.lg} />
      </Card>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  cardSpacing: { marginBottom: spacing.sm },

  errorCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm, backgroundColor: colors.dangerLight, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: tint.dangerBorder },
  errorText: { flex: 1, color: tint.onDanger, fontSize: fontSize.sm },

  deviceHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: spacing.md, paddingHorizontal: spacing.xs },
  deviceIcon: { width: 42, height: 42, borderRadius: radius.md, backgroundColor: colors.card, justifyContent: 'center', alignItems: 'center', ...shadow.subtle as any },
  deviceIconCharging: { backgroundColor: colors.warningLight },
  deviceName: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  deviceSn: { fontSize: fontSize.xs, color: colors.textMuted, fontFamily: fontMono },
  deviceMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  refreshBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.cardAlt, justifyContent: 'center', alignItems: 'center' },
  deviceTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headlineStatusDot: { width: 7, height: 7, borderRadius: 4 },
  headlineStatusText: { fontSize: fontSize.xs, fontWeight: '700' },

  healthStrip: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.lg, marginTop: spacing.sm, marginBottom: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 11, borderWidth: 1, borderColor: colors.borderLight },
  healthStripTitle: { fontSize: fontSize.sm, fontWeight: '700' },
  healthStripMessage: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },

  metricGuide: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.primaryLight, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  metricGuideIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  metricGuideTitle: { color: colors.primaryDark, fontSize: fontSize.sm, fontWeight: '800' },
  metricGuideText: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },

  safetyGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  safetyMetric: { flexGrow: 1, flexBasis: '46%', minWidth: 130, backgroundColor: colors.cardAlt, borderRadius: radius.lg, padding: spacing.md },
  safetyMetricLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  safetyMetricLabel: { fontSize: fontSize.xs, color: colors.textMuted },
  safetyMetricValue: { fontSize: fontSize.xl, fontWeight: '800', fontFamily: fontMono, marginTop: 4 },
  safetyMetricNote: { fontSize: 10, color: colors.textMuted, marginTop: 2 },

  chargingGrid: { flexDirection: 'row', gap: spacing.sm },
  chargeMetric: { flex: 1, minWidth: 0, backgroundColor: colors.warningLight, borderRadius: radius.lg, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center' },
  chargeMetricLabel: { fontSize: 10, color: tint.onWarning },
  chargeMetricValue: { fontSize: fontSize.lg, fontWeight: '800', color: tint.onWarning, fontFamily: fontMono, marginTop: 4 },
  chargeMetricNote: { fontSize: 9, color: colors.textMuted, marginTop: 3, textAlign: 'center' },
  chargeCompareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderLight },
  chargeCompareText: { fontSize: fontSize.xs, color: colors.textSecondary },
  chargeCompareDivider: { width: 1, height: 12, backgroundColor: colors.border, marginHorizontal: spacing.md },

  bmsCompactRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  bmsCompactItem: { flex: 1, backgroundColor: colors.cardAlt, borderRadius: radius.md, paddingVertical: 8, alignItems: 'center' },
  bmsCompactLabel: { fontSize: 10, color: colors.textMuted },
  bmsCompactValue: { fontSize: fontSize.sm, fontWeight: '700', fontFamily: fontMono, marginTop: 2 },

  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  rangeTabs: { flexDirection: 'row', backgroundColor: colors.cardAlt, borderRadius: radius.full, padding: 3 },
  rangeTab: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: radius.full },
  rangeTabActive: { backgroundColor: colors.card, ...shadow.subtle as any },
  rangeTabText: { fontSize: 10, color: colors.textMuted },
  rangeTabTextActive: { color: colors.primaryDark, fontWeight: '700' },
  noDataText: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.lg },
  voltageChartWrap: { flexDirection: 'row', height: 150, marginBottom: 4 },
  voltageYAxis: { width: 32, justifyContent: 'space-between', paddingRight: 4, paddingVertical: 4 },
  voltageYLabel: { fontSize: 10, color: colors.textMuted, textAlign: 'right', fontFamily: fontMono },
  voltageChartArea: { flex: 1, position: 'relative', justifyContent: 'flex-end', paddingVertical: 4 },
  voltageGridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.borderLight },
  voltageLine: { position: 'absolute', height: 2, borderRadius: 1 },
  voltagePoint: { position: 'absolute', width: 5, height: 5, borderRadius: 2.5, borderWidth: 1, borderColor: colors.card },
  voltageCrosshair: { position: 'absolute', top: 0, bottom: 0, width: 1, opacity: 0.7 },
  voltageSelectedPoint: { position: 'absolute', width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  voltageTooltip: { position: 'absolute', top: 5, width: 132, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 7, paddingVertical: 5, zIndex: 5 },
  voltageTooltipTime: { fontSize: 9, lineHeight: 12 },
  voltageTooltipValue: { fontSize: 12, lineHeight: 15, fontWeight: '800', fontFamily: fontMono },
  voltageXAxisRow: { flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 32, marginBottom: 6 },
  voltageXLabel: { fontSize: 10, color: colors.textMuted },
  voltageLegend: { flexDirection: 'row', gap: 12, paddingLeft: 32 },
  voltageLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  voltageLegendDot: { width: 8, height: 8, borderRadius: 4 },
  voltageLegendText: { fontSize: 10, color: colors.textMuted },
  chartSummaryRow: { paddingLeft: 32, marginBottom: 6 },
  chartDelta: { fontSize: 10, color: colors.textSecondary },

  chargeEventRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radius.lg, padding: 10, marginBottom: 6 },
  chargeEventIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.cardAlt, justifyContent: 'center', alignItems: 'center' },
  chargeEventIconGreen: { backgroundColor: colors.successLight },
  chargeEventTime: { fontSize: 11, color: colors.text },
  chargeEventDetail: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, fontFamily: fontMono },
  chargeEventBadge: { fontSize: fontSize.xs, color: colors.textSecondary, backgroundColor: colors.cardAlt, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  chargeEventBadgeGreen: { backgroundColor: tint.successSoft, color: tint.onSuccess },

  bmsDetailStale: { marginTop: spacing.sm, fontSize: fontSize.xs, color: colors.textMuted },

  foldedHint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs, paddingLeft: 34 },
  foldedContent: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.borderLight },
  diagnosticFootnote: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.md, textAlign: 'center' },

  detailsToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4 },
  detailsSection: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.borderLight },
  detailsToggle: { fontSize: 11, color: colors.textSecondary, marginBottom: 6 },

  generated: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', paddingBottom: 20, paddingTop: 4 },
});
