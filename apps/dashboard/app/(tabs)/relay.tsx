/**
 * 中继远控 tab —— 尾箱里那台 S7 的"遥控器"。
 *
 * 三块常驻内容：
 *  1) 环境温湿度：米家温湿度计（pvvx 固件 0x181A 广播）→ S7 被动扫描 → env_samples。
 *     注意这是车库/尾箱环境温湿度，与电池温度、S7 自身电池温度是三个独立量。
 *  2) 中继手机自身状态：在线/离线、电量、温度（同样不是电池数据）。
 *  3) 远控台：拍照（前/后）、截图、重启中继 App、重启手机、清理积压、
 *     模拟按键、交互式截图（在截图上点按=点击/拖动=滑动）、高级 shell。
 *
 * 所有指令都是异步的：下发写进 relay_commands，中继下次轮询（≤15s）取走执行，
 * 结果回传后 status 变 done。UI 轮询 fetchRelayCommands，不同步等结果。
 *
 * 权限提示：截图 / 按键 / 点击 / 滑动 / shell 走 `su`，需要 S7 的 Magisk 给
 * bms-relay 设「总是允许」；重启中继 App 不需要 root。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, GestureResponderEvent, Image, Modal,
  Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { AppText } from '../../src/components/AppText';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from 'expo-router';
import { useAuth } from '../../src/auth';
import {
  fetchRelayCommands, fetchRelayStatus, getBaseUrl,
  issueRelayCommand, rewriteToBase,
} from '../../src/api';
import { getTempWarnC, getTempDangerC } from '../../src/widgetData';
import type { RelayCommand, RelayStatus } from '../../src/types';
import { Card } from '../../src/components/Card';
import { EmptyState } from '../../src/components/EmptyState';
import { Grid } from '../../src/components/Grid';
import { MetricTile } from '../../src/components/MetricTile';
import { SectionHeader } from '../../src/components/SectionHeader';
import { StatusPill } from '../../src/components/StatusPill';
import { LinearGradient } from '../../src/components/LinearGradient';
import { FadeIn, Pulse } from '../../src/components/Motion';
import { useHeaderTheme } from '../../src/hooks/useHeaderTheme';
import { BackButton } from '../../src/components/BackButton';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useStagger, enterStyle } from '../../src/hooks/useStagger';
import { colors, fontMono, fontSize, headerThemes, radius, shadow, spacing, tint } from '../../src/theme';
import { useAppTheme } from '../../src/ThemeProvider';
import { useVehicleData } from '../../src/vehicleData';
import { useDemoMode } from '../../src/demo/DemoModeProvider';

/** 中继轮询间隔 15s，留足两轮 + 上传时间再判超时。 */
const CMD_POLL_MS = 3_000;
const STATUS_POLL_MS = 10_000;

/** 指令中文名（历史列表 / 截图镜像提示用）。 */
const CMD_LABEL: Record<string, string> = {
  photo: '拍照',
  screencap: '截图',
  restart: '重启中继App',
  reboot: '重启手机',
  shutdown: '关机',
  flush: '清理积压',
  'clear-backlog': '清空离线缓存',
  shell: 'Shell 命令',
  key: '模拟按键',
  tap: '点击',
  swipe: '滑动',
  update_apk: '更新中继固件',
};

/** 模拟按键：常用实体键（code 用 Android keyevent 数字）。 */
const KEYS: { label: string; icon: string; code: string }[] = [
  { label: 'Home', icon: 'home-outline', code: '3' },
  { label: '返回', icon: 'arrow-back-outline', code: '4' },
  { label: '多任务', icon: 'square-outline', code: '187' },
  { label: '电源', icon: 'power-outline', code: '26' },
  { label: '音量+', icon: 'volume-high-outline', code: '24' },
  { label: '音量-', icon: 'volume-low-outline', code: '25' },
];

export default function RelayScreen() {
  const { unlocked } = useAuth();
  const { top } = useHeaderTheme(headerThemes.relay);
  const rs = useResponsive();
  const { colors: themeColors } = useAppTheme();
  const { isDemoMode } = useDemoMode();
  const isFocused = useIsFocused();
  const { selectedSn: deviceSn, loading: vehicleLoading } = useVehicleData();

  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [commands, setCommands] = useState<RelayCommand[]>([]);
  const [base, setBase] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);
  const [tempWarnC, setTempWarnC] = useState(40);
  const [tempDangerC, setTempDangerC] = useState(45);

  /** 当前正在飞行的指令（全局互斥，避免按钮乱点）。 */
  const [working, setWorking] = useState<{ command: string; phase: 'issuing' | 'pending' | 'dispatched'; stage: string } | null>(null);
  const busyRef = useRef(false);
  const commandRunRef = useRef(0);
  const commandTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = working !== null;

  /** 截图镜像：screencap 完成后把图片放这里，可在图上点按/拖动。 */
  const [mirror, setMirror] = useState<{ url: string; natW: number; natH: number } | null>(null);
  const [mirrorFailed, setMirrorFailed] = useState(false);
  const [mirrorW, setMirrorW] = useState(0);
  const mirrorTouch = useRef<{ x: number; y: number } | null>(null);

  /** 高级 shell。 */

  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerCommandId, setViewerCommandId] = useState<number | null>(null);
  const [viewerFailed, setViewerFailed] = useState(false);
  const [developerOpen, setDeveloperOpen] = useState(false);

  useEffect(() => { getBaseUrl().then(setBase).catch(() => {}); }, []);
  useEffect(() => {
    (async () => {
      setTempWarnC(await getTempWarnC());
      setTempDangerC(await getTempDangerC());
    })();
  }, []);

  useEffect(() => {
    if (unlocked && !vehicleLoading && !deviceSn) {
      setError('未找到当前车辆，无法连接中继');
      setLoading(false);
    }
  }, [unlocked, vehicleLoading, deviceSn]);

  useEffect(() => () => {
    commandRunRef.current++;
    if (commandTimerRef.current) clearInterval(commandTimerRef.current);
    busyRef.current = false;
  }, []);

  // 切换车辆时不能让上一辆车的轮询结果写进当前页面，也不能继续占用远控锁。
  useEffect(() => {
    commandRunRef.current++;
    if (commandTimerRef.current) clearInterval(commandTimerRef.current);
    commandTimerRef.current = null;
    busyRef.current = false;
    setWorking(null);
    setRelay(null);
    setCommands([]);
    setMirror(null);
    setViewerUrl(null);
    setViewerCommandId(null);
    if (deviceSn) setLoading(true);
  }, [deviceSn]);

  const load = useCallback(async (isRefresh = false) => {
    if (!deviceSn) return;
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;
    if (isRefresh) setRefreshing(true);
    try {
      const [r, cs] = await Promise.all([
        fetchRelayStatus(deviceSn),
        fetchRelayCommands(deviceSn).catch(() => [] as RelayCommand[]),
      ]);
      if (!isCurrent()) return;
      setRelay(r);
      setCommands(cs);
      setError(null);
    } catch (e: any) {
      if (isCurrent()) setError(e?.message ?? '加载失败');
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [deviceSn]);

  useEffect(() => {
    loadSeqRef.current++;
    if (!deviceSn || !isFocused) return;
    void load();
    const t = setInterval(() => { void load(); }, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [deviceSn, isFocused, load]);

  const openViewer = useCallback((url: string, commandId?: number) => {
    setViewerFailed(false);
    setViewerCommandId(commandId ?? null);
    setViewerUrl(rewriteToBase(url, base));
  }, [base]);

  const retryViewer = useCallback(async () => {
    if (!deviceSn || viewerCommandId == null) return;
    try {
      const cs = await fetchRelayCommands(deviceSn);
      setCommands(cs);
      const fresh = cs.find(c => c.id === viewerCommandId);
      const url = fresh?.result?.photo_url;
      if (typeof url !== 'string' || !url) throw new Error('服务器未返回新的照片地址');
      setViewerFailed(false);
      setViewerUrl(rewriteToBase(url, base));
    } catch (e) {
      Alert.alert('刷新失败', e instanceof Error ? e.message : '请稍后重试');
    }
  }, [deviceSn, viewerCommandId, base]);

  /**
   * 通用指令下发 + 轮询。返回最终命令对象（done/failed/超时均 resolve）。
   * onStage 用于更新进行中提示；onDone 在 done 时回调（拿到 result）。
   */
  const runCommand = useCallback((
    command: string,
    payload?: Record<string, unknown>,
    opts: { timeoutMs?: number; onStage?: (s: string) => void; onDone?: (c: RelayCommand) => void } = {},
  ): Promise<RelayCommand | null> => {
    if (isDemoMode) {
      Alert.alert('演示模式', '演示模式：不会执行真实设备操作。');
      return Promise.resolve(null);
    }
    if (!deviceSn || busyRef.current) return Promise.resolve(null);
    const runId = ++commandRunRef.current;
    busyRef.current = true;
    const timeoutMs = opts.timeoutMs ?? 90_000;
    setWorking({ command, phase: 'issuing', stage: '正在下发指令…' });
    const setStage = (phase: 'issuing' | 'pending' | 'dispatched', stage: string) => setWorking(w => (w ? { ...w, phase, stage } : w));
    const finish = () => {
      if (commandRunRef.current !== runId) return;
      if (commandTimerRef.current) clearInterval(commandTimerRef.current);
      commandTimerRef.current = null;
      busyRef.current = false;
      setWorking(null);
    };
    let cmdId = -1;
    let expiresAt: string | null = null;
    return (async () => {
      try {
        const cmd = await issueRelayCommand(deviceSn, command, payload);
        if (commandRunRef.current !== runId) return null;
        cmdId = cmd.id;
        expiresAt = cmd.expires_at;
        setStage('pending', '等待中继取走…');
      } catch (e: any) {
        finish();
        Alert.alert('下发失败', e?.message ?? '请检查服务器连接');
        return null;
      }
      opts.onStage?.('等待中继取指令（≤15 秒）…');
      const started = Date.now();
      return await new Promise<RelayCommand | null>((resolve) => {
        let polling = false;
        commandTimerRef.current = setInterval(async () => {
          if (polling) return;
          if (commandRunRef.current !== runId) return;
          polling = true;
          try {
            const cs = await fetchRelayCommands(deviceSn);
            if (commandRunRef.current !== runId) return;
            setCommands(cs);
            const mine = cs.find(c => c.id === cmdId);
            if (mine?.status === 'dispatched') setStage('dispatched', '中继已取走，正在执行…');
            if (mine?.status === 'done') {
              finish();
              opts.onDone?.(mine);
              resolve(mine);
              return;
            }
            if (mine?.status === 'failed') {
              finish();
              Alert.alert('执行失败', mine.error || '中继执行失败');
              resolve(mine);
              return;
            }
            // 服务端已把它判成终态，再等下去只会空转到超时。
            if (mine?.status === 'expired') {
              finish();
              Alert.alert('指令已超时', mine.error || '中继未在有效期内回报结果');
              resolve(mine);
              return;
            }
          } catch { /* 网络抖动，下一轮再试 */ }
          finally { polling = false; }
          if (Date.now() - started > timeoutMs) {
            const expiryMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
            const stillValid = Number.isFinite(expiryMs) && expiryMs > Date.now();
            finish();
            Alert.alert(
              '等待超时',
              '中继在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有回传结果。' + (stillValid
                ? '指令仍在有效期内，中继恢复联网后可能继续执行；稍后下拉刷新查看结果。'
                : '指令已接近或超过有效期，请先刷新历史状态，再决定是否重新下发。'),
            );
            resolve(null);
          }
        }, CMD_POLL_MS);
      });
    })();
  }, [deviceSn, isDemoMode]);

  const connected = relay?.connected === true;
  const relayHealth = !relay?.present
    ? { label: '尚未接入', detail: '还没有收到中继心跳', icon: 'radio-outline' as const, fg: themeColors.textMuted, bg: themeColors.surfaceSecondary }
    : connected && relay.board_state === 'live'
      ? { label: '运行正常', detail: '中继在线，保护板数据实时', icon: 'ellipse' as const, fg: themeColors.textSecondary, bg: themeColors.surfaceSecondary }
      : connected && relay.board_state === 'connected_stale'
        ? { label: '中继在线，保护板已连接', detail: `等待最新数据 · ${relay.ble_status || '保护板轮询中'}`, icon: 'time-outline' as const, fg: themeColors.warning, bg: themeColors.warningSoft }
      : connected
        ? { label: '中继在线，保护板未连接', detail: relay.ble_status || '正在扫描保护板', icon: 'bluetooth-outline' as const, fg: themeColors.warning, bg: themeColors.warningSoft }
        : { label: '中继离线', detail: `最后心跳 ${fmtAge((relay.age_seconds ?? 0) * 1000)}`, icon: 'cloud-offline-outline' as const, fg: themeColors.danger, bg: themeColors.dangerSoft };

  /** 远程截图：完成后把图放进 mirror，可在图上交互点按/拖动。 */
  const handleScreencap = useCallback(() => {
    void runCommand('screencap', {}, { timeoutMs: 60_000 }).then(c => {
      const url = c?.result?.photo_url;
      if (typeof url === 'string' && url) {
        setMirrorFailed(false);
        setMirror({ url: rewriteToBase(url, base), natW: 0, natH: 0 });
      } else if (c?.status === 'done') {
        Alert.alert('已截图', '中继报告完成，但没有回传图片地址');
      }
    });
  }, [runCommand, base]);

  const confirmRun = (title: string, message: string, command: string, payload?: Record<string, unknown>) => {
    Alert.alert(title, message, [
      { text: '取消', style: 'cancel' },
      { text: '确认', style: 'destructive', onPress: () => void runCommand(command, payload, { timeoutMs: 60_000 }) },
    ]);
  };

  /** 截图镜像：在图上点按=点击，拖动=滑动（坐标按原图分辨率换算）。 */
  const onMirrorStart = (e: GestureResponderEvent) => {
    mirrorTouch.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
  };
  const onMirrorEnd = (e: GestureResponderEvent) => {
    if (!mirror || !mirrorTouch.current || mirror.natW <= 0 || mirrorW <= 0) return;
    const sx = mirrorTouch.current.x, sy = mirrorTouch.current.y;
    const ex = e.nativeEvent.locationX, ey = e.nativeEvent.locationY;
    const renderedH = mirrorW * mirror.natH / mirror.natW;
    const dx = mirror.natW / mirrorW, dy = mirror.natH / renderedH;
    const X1 = Math.round(sx * dx), Y1 = Math.round(sy * dy);
    const X2 = Math.round(ex * dx), Y2 = Math.round(ey * dy);
    const dist = Math.hypot(ex - sx, ey - sy);
    mirrorTouch.current = null;
    if (dist < 12) void runCommand('tap', { x: X1, y: Y1 }, { timeoutMs: 30_000 });
    else void runCommand('swipe', { x1: X1, y1: Y1, x2: X2, y2: Y2, duration_ms: 300 }, { timeoutMs: 30_000 });
  };

  const handleKey = (code: string) => void runCommand('key', { code }, { timeoutMs: 30_000 });

  const anims = useStagger(3);
  const amb = relay?.ambient ?? null;

  if (!deviceSn && (loading || vehicleLoading)) {
    return (
      <ScrollView style={[s.container, { backgroundColor: themeColors.background }]} contentContainerStyle={{ padding: rs.pagePad, paddingTop: top }}>
        <BackButton />
        <EmptyState
          variant="pulse" icon="radio-outline" title="连接中继…"
          subtitle="正在读取尾箱 S7 的状态与温湿度"
          accent={themeColors.primary} accentBg={themeColors.primarySoft}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={[s.container, { backgroundColor: themeColors.background }]}
      contentContainerStyle={{ padding: rs.pagePad, paddingTop: top, paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
    >
      <BackButton />
      {error && !relay && (
        <EmptyState
          variant="float" icon="alert-circle-outline" title="加载失败" subtitle={error}
          accent={colors.danger} accentBg={colors.dangerLight}
          actionLabel="重试" onAction={() => { if (deviceSn) void load(); }}
        />
      )}

      {/* ── 1. 环境温湿度 ── */}
      <Animated.View style={enterStyle(anims[0])}>
        <Card style={s.card}>
          <View style={[s.relayHealth, { backgroundColor: relayHealth.bg }]}>
            <View style={[s.relayHealthIcon, { backgroundColor: themeColors.surface }]}>
              <Ionicons name={relayHealth.icon} size={19} color={relayHealth.fg} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText style={[s.relayHealthTitle, { color: relayHealth.fg }]}>{relayHealth.label}</AppText>
              <AppText style={[s.relayHealthText, { color: themeColors.textMuted }]} numberOfLines={2}>{relayHealth.detail}</AppText>
            </View>
          </View>
          <View style={s.cardHead}>
            <View style={s.cardTitleWrap}>
              <Ionicons name="thermometer-outline" size={18} color={themeColors.primary} />
              <AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>环境温湿度</AppText>
            </View>
            {amb ? (
              <StatusPill
                label={amb.fresh ? '实时' : '数据陈旧'}
                icon={amb.fresh ? 'radio' : 'time-outline'}
                fg={amb.fresh ? themeColors.textSecondary : themeColors.warning}
                bg={amb.fresh ? themeColors.surfaceSecondary : themeColors.warningSoft}
              />
            ) : (
              <StatusPill label="未接入" icon="ellipse-outline" fg={themeColors.textMuted} bg={themeColors.surfaceSecondary} />
            )}
          </View>

          {amb ? (
            <>
              <Grid cols={2} gap={rs.gridGap}>
                <MetricTile
                  icon="thermometer-outline" num={amb.temp_c} decimals={1} unit="°C" label="温度"
                  accent={tempColor(amb.temp_c, tempWarnC, tempDangerC)} hintKey="ambient_temp"
                />
                <MetricTile
                  icon="water-outline" num={amb.humidity_pct} decimals={0} unit="%" label="相对湿度"
                  accent={humColor(amb.humidity_pct)} hintKey="ambient_humidity"
                />
              </Grid>
              <View style={s.divider} />
              <Grid cols={2} gap={rs.gridGap}>
                <MetricTile
                  icon="battery-half-outline"
                  num={amb.sensor_battery_mv != null ? amb.sensor_battery_mv / 1000 : null}
                  decimals={2} unit="V" label="温湿度计电池"
                  accent={amb.sensor_battery_mv != null && amb.sensor_battery_mv < 2500 ? colors.danger : undefined}
                  hintKey="ambient_sensor_battery"
                />
                <MetricTile icon="cellular-outline" num={amb.rssi} unit="dBm" label="广播信号" hintKey="rssi" />
              </Grid>
              <AppText style={[s.footNote, { color: themeColors.textMuted }]}>
                {amb.fresh
                  ? `最后读数 ${fmtAge((amb.age_seconds ?? 0) * 1000)} · 米家温湿度计（pvvx 广播）`
                  : `已 ${fmtAge((amb.age_seconds ?? 0) * 1000)} 无新读数 · 检查温湿度计电池或与 S7 的距离`}
              </AppText>
            </>
          ) : (
            <AppText style={[s.footNote, { color: themeColors.textMuted }]}>
              尚未收到任何温湿度广播。确认温湿度计已刷 pvvx 固件、广播类型为 Custom，
              且 MAC 与中继设置里配置的设备一致。
            </AppText>
          )}
        </Card>
      </Animated.View>

      {/* ── 2. 中继手机状态 ── */}
      <Animated.View style={enterStyle(anims[1])}>
        <Card style={s.card}>
          <View style={s.cardHead}>
            <View style={s.cardTitleWrap}>
              <Ionicons name="phone-portrait-outline" size={18} color={themeColors.primary} />
              <AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>中继手机（S7）</AppText>
            </View>
            <View style={s.pills}>
              {relay?.phone_charging === true && <StatusPill kind="charging" label="充电中" />}
              <StatusPill
                label={!relay?.present ? '未启用' : connected ? (relay?.board_state === 'live' ? '板实时' : relay?.board_state === 'connected_stale' ? '板已连·待同步' : '在线') : '离线'}
                icon={connected ? 'wifi' : 'wifi-outline'}
                fg={connected ? themeColors.textSecondary : themeColors.danger}
                bg={connected ? themeColors.surfaceSecondary : themeColors.dangerSoft}
              />
            </View>
          </View>

          <Grid cols={3} gap={rs.gridGap}>
            <MetricTile
              icon="battery-full-outline"
              num={relay?.phone_battery_level_pct != null ? Math.round(relay.phone_battery_level_pct) : null}
              unit="%" label="手机电量"
              accent={
                relay?.phone_battery_level_pct != null && relay.phone_battery_level_pct <= 15
                  ? colors.danger : undefined
              }
              hintKey="relay_phone_battery"
            />
            <MetricTile icon="thermometer-outline" num={relay?.phone_battery_temp_c ?? null} decimals={1} unit="°C" label="手机温度" hintKey="relay_phone_temp" />
            <MetricTile icon="flash-outline" num={relay?.phone_battery_voltage_v ?? null} decimals={2} unit="V" label="手机电压" hintKey="relay_phone_voltage" />
            <MetricTile
              icon="phone-portrait-outline"
              mono={false}
              value={relay?.phone_screen_on == null ? '--' : relay.phone_screen_on ? '亮屏' : '熄屏'}
              label="屏幕"
              hintKey="relay_phone_screen"
            />
          </Grid>

          <AppText style={[s.footNote, { color: themeColors.textMuted }]}>
            {!relay?.present
              ? '尚未收到中继心跳（请确认 bms-relay 已启动并填入本车 SN）'
              : connected
                ? `最后心跳 ${fmtAge((relay.age_seconds ?? 0) * 1000)}`
                : `中继离线 · 最后心跳 ${fmtAge((relay?.age_seconds ?? 0) * 1000)}`}
          </AppText>
        </Card>
      </Animated.View>

      {/* ── 3. 远控台 ── */}
      <Animated.View style={enterStyle(anims[2])}>
        <LinearGradient from={themeColors.primary} to={themeColors.info} style={s.hero} steps={24}>
          <View style={s.heroTop}>
            <View style={{ flex: 1 }}>
              <AppText style={s.heroTitle}>远程看看车辆</AppText>
              <AppText style={s.heroSub}>让尾箱里的中继手机拍一张现场照片</AppText>
            </View>
            {busy && (
              <Pulse active minOpacity={0.35} scaleTo={1.25}>
                <View style={s.heroIcon}><Ionicons name="sync-outline" size={20} color="#fff" /></View>
              </Pulse>
            )}
          </View>

          {busy && (
            <View style={[s.commandProgressWrap, { backgroundColor: themeColors.surface }]}>
              <View style={s.heroBtnRow}>
                <ActivityIndicator size="small" color={themeColors.primary} />
                <AppText style={[s.heroBtnText, { color: themeColors.primary }]}>{working?.stage || '执行中…'}</AppText>
              </View>
              <CommandProgress phase={working?.phase ?? 'issuing'} />
            </View>
          )}

          <AppText style={s.heroNote}>
            {connected
              ? '中继在线：约 15 秒内取走指令并执行'
              : '中继离线：指令会排队（24 小时有效），S7 恢复联网后自动执行'}
          </AppText>
        </LinearGradient>
      </Animated.View>

      {/* 日常入口只保留拍照；系统控制统一收进高级工具。 */}
      <Card style={s.card}>
        <SectionHeader icon="camera-outline" title="拍照记录" badge={connected ? '可用' : '恢复联网后执行'} badgeTone={connected ? 'emerald' : 'gray'} style={{ marginBottom: spacing.md }} />
        <Grid cols={2} gap={spacing.sm}>
          <RcTile icon="camera-outline" label="拍摄车辆周围" disabled={busy} onPress={() => void runCommand('photo', { facing: 'back' }, { timeoutMs: 90_000 }).then(showImg)} />
          <RcTile icon="person-outline" label="拍摄尾箱内部" disabled={busy} onPress={() => void runCommand('photo', { facing: 'front' }, { timeoutMs: 90_000 }).then(showImg)} />
        </Grid>
      </Card>

      <Card style={s.card}>
        <Pressable onPress={() => setDeveloperOpen(v => !v)} style={s.advancedToggle}>
          <View style={[s.advancedIcon, { backgroundColor: themeColors.primarySoft }]}><Ionicons name="construct-outline" size={18} color={themeColors.primary} /></View>
          <View style={{ flex: 1 }}><AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>高级远控工具</AppText><AppText style={[s.advancedSub, { color: themeColors.textMuted }]}>截图、重启、模拟按键与指令记录</AppText></View>
          <Ionicons name={developerOpen ? 'chevron-up' : 'chevron-down'} size={17} color={themeColors.textMuted} />
        </Pressable>
      </Card>

      {developerOpen && <>
      <Card style={s.card}>
        <SectionHeader icon="terminal-outline" title="系统操作" badge="开发者" badgeTone="gray" style={{ marginBottom: spacing.md }} />
        <Grid cols={3} gap={spacing.sm}>
          <RcTile icon="scan-outline" label="远程截图" disabled={busy} onPress={handleScreencap} />
          <RcTile icon="refresh-outline" label="重启中继App" disabled={busy} danger
            onPress={() => confirmRun('重启中继 App', '将重启 S7 上的 bms-relay 服务（无需 root）。确定继续？', 'restart')} />
          <RcTile icon="power-outline" label="重启手机" disabled={busy} danger
            onPress={() => confirmRun('重启手机', '将重启整台 S7（需 Magisk 授权）。确定继续？', 'reboot')} />
          <RcTile icon="trash-outline" label="清理积压" disabled={busy}
            onPress={() => void runCommand('flush', {}, { timeoutMs: 30_000 })} />
        </Grid>
      </Card>

      {/* 模拟按键 */}
      <Card style={s.card}>
        <SectionHeader icon="keypad-outline" title="模拟按键" style={{ marginBottom: spacing.md }} />
        <AppText style={[s.footNote, { color: themeColors.textMuted }]}>需 S7 的 Magisk 给 bms-relay 设「总是允许」。</AppText>
        <Grid cols={3} gap={spacing.sm}>
          {KEYS.map(k => (
            <RcTile key={k.code} icon={k.icon} label={k.label} disabled={busy} onPress={() => handleKey(k.code)} />
          ))}
        </Grid>
      </Card>

      {/* 截图镜像（交互式点按/滑动） */}
      {mirror && (
        <Card style={s.card}>
          <View style={s.cardHead}>
            <View style={s.cardTitleWrap}>
              <Ionicons name="scan-outline" size={18} color={themeColors.primary} />
              <AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>截图镜像</AppText>
            </View>
            <Pressable hitSlop={8} onPress={() => setMirror(null)}>
              <Ionicons name="close-circle-outline" size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          <AppText style={[s.footNote, { color: themeColors.textMuted }]}>在图上<AppText style={{ fontWeight: '700' }}>点按=点击</AppText>、<AppText style={{ fontWeight: '700' }}>拖动=滑动</AppText>（坐标已按原图分辨率换算）。</AppText>
          <View
            style={[s.mirrorWrap, mirror.natW > 0 && mirrorW > 0 ? { height: mirrorW * mirror.natH / mirror.natW } : null]}
            onLayout={e => setMirrorW(e.nativeEvent.layout.width)}
            onTouchStart={onMirrorStart}
            onTouchEnd={onMirrorEnd}
          >
            <Image
              source={{ uri: mirror.url }} style={s.mirrorImg} resizeMode="contain"
              onLoad={e => { const { width, height } = e.nativeEvent.source; setMirror(m => m ? { ...m, natW: width, natH: height } : m); }}
              onError={() => setMirrorFailed(true)}
            />
            {mirrorFailed && <View style={s.mirrorError}><Ionicons name="image-outline" size={24} color={colors.textMuted} /><AppText style={s.mirrorErrorText}>截图链接已失效，请重新截图</AppText></View>}
          </View>
          <RcTile icon="scan-outline" label="重新截图" disabled={busy} onPress={handleScreencap} />
        </Card>
      )}

      {/* 指令历史（所有类型） */}
      <SectionHeader
        icon="time-outline"
        title="指令历史"
        accessory={commands.length > 0 ? <AppText style={[s.sectionCount, { color: themeColors.textMuted }]}>共 {commands.length} 条</AppText> : undefined}
        style={{ marginTop: spacing.lg, marginBottom: spacing.md }}
      />

      {commands.length === 0 ? (
        <EmptyState
          variant="float" icon="terminal-outline" title="还没有指令"
          subtitle="点上面的按钮下发第一条远控指令"
          accent={colors.textSecondary} accentBg={colors.cardAlt}
        />
      ) : (
        commands.map((c, i) => (
          <FadeIn key={c.id} index={i} style={s.cmdRow}>
            <CmdCard cmd={c} base={base} onOpen={openViewer} />
          </FadeIn>
        ))
      )}
      </>}

      {/* 全屏看图 */}
      <Modal visible={viewerUrl !== null} transparent onRequestClose={() => { setViewerUrl(null); setViewerCommandId(null); }}>
        <View style={s.modalBg}>
          <Pressable style={s.modalClose} hitSlop={10} onPress={() => { setViewerUrl(null); setViewerCommandId(null); }}>
            <Ionicons name="close" size={18} color="#fff" />
          </Pressable>
          {viewerFailed ? (
            <View style={s.modalFailed}>
              <Ionicons name="image-outline" size={40} color="rgba(255,255,255,0.6)" />
              <AppText style={s.modalFailedText}>照片链接可能已过期</AppText>
              {viewerCommandId != null && <Pressable style={s.modalRetry} onPress={() => { void retryViewer(); }}>
                <Ionicons name="refresh" size={16} color="#fff" />
                <AppText style={s.modalRetryText}>刷新链接并重试</AppText>
              </Pressable>}
            </View>
          ) : viewerUrl ? (
            <Image
              source={{ uri: viewerUrl }} style={s.modalImage} resizeMode="contain"
              onError={() => setViewerFailed(true)}
            />
          ) : null}
        </View>
      </Modal>
    </ScrollView>
  );

  /** 拍照/截图完成后若带 photo_url，直接进全屏看图。 */
  function showImg(c?: RelayCommand | null) {
    const url = c?.result?.photo_url;
    if (typeof url === 'string' && url) openViewer(url, c?.id);
    else if (c?.status === 'done') Alert.alert('已拍照', '中继报告完成，但没有回传照片地址');
  }
}

/** 远控台按钮（网格单元，填充整格）。 */
function RcTile({
  icon, label, onPress, disabled, danger,
}: { icon: string; label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  const { colors: c } = useAppTheme();
  return (
    <Pressable
      style={({ pressed }) => [
        s.rcTile,
        { backgroundColor: c.surfaceSecondary },
        pressed && !disabled && { opacity: 0.8, transform: [{ scale: 0.97 }] },
        disabled && { opacity: 0.45 },
      ]}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
    >
      <View style={[s.rcTileIcon, { backgroundColor: c.primarySoft }, danger && { backgroundColor: c.dangerSoft }]}>
        <Ionicons name={icon as any} size={22} color={danger ? c.danger : c.primary} />
      </View>
      <AppText style={[s.rcTileLabel, danger && { color: colors.danger }]} numberOfLines={1}>{label}</AppText>
    </Pressable>
  );
}

function CommandProgress({ phase }: { phase: 'issuing' | 'pending' | 'dispatched' }) {
  const { colors: c } = useAppTheme();
  const active = phase === 'issuing' ? 0 : phase === 'pending' ? 1 : 2;
  return (
    <View style={s.progressRow}>
      {['下发', '待取走', '执行', '完成'].map((label, index) => (
        <View key={label} style={s.progressStepWrap}>
          <View style={[s.progressDot, { backgroundColor: c.border }, index <= active && { backgroundColor: c.primary }]} />
          <AppText style={[s.progressLabel, { color: c.textMuted }, index <= active && { color: c.primary, fontWeight: '700' }]}>{label}</AppText>
          {index < 3 && <View style={[s.progressLine, { backgroundColor: c.border }, index < active && { backgroundColor: c.primary }]} />}
        </View>
      ))}
    </View>
  );
}

/** 单条指令：状态徽标 + 名称 + 时间 + 缩略图（有图）或输出（shell）。 */
function CmdCard({
  cmd, base, onOpen,
}: { cmd: RelayCommand; base: string; onOpen: (url: string, commandId?: number) => void }) {
  const { colors: c } = useAppTheme();
  const [failed, setFailed] = useState(false);
  const url = typeof cmd.result?.photo_url === 'string' ? cmd.result.photo_url : null;
  const thumb = url ? rewriteToBase(url, base) : null;
  const output = typeof cmd.result?.output === 'string' ? cmd.result.output : null;
  const tone = STATUS_TONE[cmd.status] ?? STATUS_TONE.pending;

  return (
    <Card variant="flat" pad={false} style={s.cmdCard}>
      <Pressable
        style={s.cmdInner}
        disabled={!thumb}
        onPress={() => { if (url) onOpen(url, cmd.id); }}
      >
        <View style={[s.cmdThumbWrap, { backgroundColor: c.surfaceSecondary }]}>
          {thumb && !failed ? (
            <Image source={{ uri: thumb }} style={s.cmdThumb} resizeMode="cover" onError={() => setFailed(true)} />
          ) : (
            <View style={s.cmdThumbEmpty}>
              <Ionicons
                name={
                  cmd.status === 'failed' ? 'close-circle-outline'
                    : cmd.status === 'expired' ? 'alert-circle-outline'
                      : cmd.command === 'shell' ? 'terminal-outline'
                        : 'hourglass-outline'
                }
                size={20}
                color={colors.textMuted}
              />
            </View>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <View style={s.cmdHeadRow}>
            <View style={[s.cmdBadge, { backgroundColor: tone.bg }]}>
              <AppText style={[s.cmdBadgeText, { color: tone.fg }]}>{tone.label}</AppText>
            </View>
            <AppText style={[s.cmdTime, { color: c.textMuted }]}>{fmtTime(cmd.executed_at ?? cmd.created_at)}</AppText>
          </View>
          <AppText style={[s.cmdMeta, { color: c.textMuted }]} numberOfLines={1}>
            {CMD_LABEL[cmd.command] ?? cmd.command} · #{cmd.id}
          </AppText>
          {output ? (
            <AppText style={[s.cmdOutput, { color: c.primary }]} numberOfLines={2}>{output}</AppText>
          ) : cmd.error ? (
            <AppText style={s.cmdError} numberOfLines={2}>{cmd.error}</AppText>
          ) : null}
        </View>
        {thumb && !failed ? <Ionicons name="chevron-forward" size={16} color={c.textDim} /> : null}
      </Pressable>
    </Card>
  );
}

// expired = 服务端 sweep 判定的终态：中继始终没回报，已放弃。与 failed（中继
// 真的执行了但失败了）语义不同，故用灰底作废态而不是红色。缺这一项时未知状态
// 会回退成「待取走」，看上去像还在排队，正好把问题藏起来。
const STATUS_TONE: Record<string, { label: string; fg: string; bg: string }> = {
  pending:    { label: '待取走', fg: colors.textSecondary, bg: colors.cardAlt },
  dispatched: { label: '执行中', fg: tint.onWarning,        bg: colors.warningLight },
  done:       { label: '已完成', fg: tint.onEmerald,        bg: tint.successSoft },
  failed:     { label: '失败',   fg: colors.danger,        bg: colors.dangerLight },
  expired:    { label: '已超时', fg: colors.textMuted,     bg: colors.border },
};

function tempColor(t: number | null, warnC: number, dangerC: number): string | undefined {
  if (t == null) return undefined;
  if (t >= dangerC || t <= 0) return colors.danger;
  if (t >= warnC || t <= 5) return colors.warning;
  return undefined;
}

function humColor(h: number | null): string | undefined {
  if (h == null) return undefined;
  if (h >= 85 || h <= 15) return colors.danger;
  if (h >= 75 || h <= 25) return colors.warning;
  return undefined;
}

function fmtAge(ageMs: number): string {
  if (ageMs < 60000) return '刚刚';
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)} 分钟前`;
  if (ageMs < 86400000) return `${Math.floor(ageMs / 3600000)} 小时前`;
  return `${Math.floor(ageMs / 86400000)} 天前`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  card: { marginBottom: spacing.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  relayHealth: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  relayHealthIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  relayHealthTitle: { fontSize: fontSize.md, fontWeight: '800' },
  relayHealthText: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.borderLight, marginVertical: spacing.sm },
  footNote: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', marginTop: spacing.md, lineHeight: 16 },
  advancedToggle: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  advancedIcon: { width: 38, height: 38, borderRadius: radius.md, backgroundColor: colors.cardAlt, justifyContent: 'center', alignItems: 'center' },
  advancedSub: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },

  hero: { borderRadius: radius.xxl, padding: spacing.xl, marginTop: spacing.xs } as any,
  heroTop: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
  heroTitle: { fontSize: fontSize.xl, fontWeight: '800', color: '#fff' },
  heroSub: { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.82)', marginTop: 3 },
  heroIcon: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.18)', justifyContent: 'center', alignItems: 'center',
  },
  heroBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroBtnText: { color: colors.accentTeal, fontSize: fontSize.md, fontWeight: '700' },
  commandProgressWrap: { backgroundColor: 'rgba(255,255,255,0.94)', borderRadius: radius.lg, padding: spacing.md },
  progressRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.md },
  progressStepWrap: { flex: 1, alignItems: 'center', position: 'relative' },
  progressDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  progressDotActive: { backgroundColor: colors.accentTeal },
  progressLabel: { color: colors.textMuted, fontSize: 10, marginTop: 4 },
  progressLabelActive: { color: colors.primaryDark, fontWeight: '700' },
  progressLine: { position: 'absolute', height: 2, backgroundColor: colors.border, left: '62%', right: '-38%', top: 3 },
  progressLineActive: { backgroundColor: colors.accentTeal },
  heroNote: { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.8)', textAlign: 'center', marginTop: spacing.md },

  rcTile: {
    width: '100%', backgroundColor: colors.cardAlt, borderRadius: radius.lg,
    paddingVertical: spacing.lg, alignItems: 'center', gap: spacing.sm,
  },
  rcTileIcon: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: '#ecfeff',
    justifyContent: 'center', alignItems: 'center',
  },
  rcTileLabel: { fontSize: fontSize.xs, fontWeight: '600', color: colors.text },

  mirrorWrap: {
    width: '100%', backgroundColor: '#000', borderRadius: radius.lg, overflow: 'hidden',
    marginTop: spacing.sm,
  },
  mirrorImg: { width: '100%', height: '100%' },
  mirrorError: { position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.cardAlt },
  mirrorErrorText: { color: colors.textMuted, fontSize: fontSize.xs },

  shellHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  shellRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'stretch' },
  shellInput: {
    flex: 1, minHeight: 44, backgroundColor: colors.cardAlt, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: fontSize.sm,
    fontFamily: fontMono, textAlignVertical: 'top',
  },
  shellSend: {
    width: 76, backgroundColor: colors.accentTeal, borderRadius: radius.md,
    justifyContent: 'center', alignItems: 'center', paddingVertical: 12,
  },
  shellSendText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  shellOut: {
    marginTop: spacing.sm, backgroundColor: '#0b1020', borderRadius: radius.md, padding: 10,
  },
  shellOutText: { color: '#9fe7c8', fontFamily: fontMono, fontSize: fontSize.xs, lineHeight: 16 },

  sectionCount: { fontSize: fontSize.sm, color: colors.textMuted },
  cmdRow: { marginBottom: spacing.sm },
  cmdCard: { ...shadow.subtle } as any,
  cmdInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  cmdThumbWrap: { width: 54, height: 54, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.cardAlt },
  cmdThumb: { width: '100%', height: '100%' },
  cmdThumbEmpty: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' },
  cmdHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cmdBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.xs },
  cmdBadgeText: { fontSize: fontSize.xs, fontWeight: '700' },
  cmdTime: { fontSize: fontSize.xs, color: colors.textMuted, fontFamily: fontMono },
  cmdMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3, fontFamily: fontMono },
  cmdOutput: { fontSize: fontSize.xs, color: colors.accentTeal, marginTop: 2, fontFamily: fontMono },
  cmdError: { fontSize: fontSize.xs, color: colors.danger, marginTop: 2 },

  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' },
  modalClose: {
    position: 'absolute', top: 50, right: 20, width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', zIndex: 10,
  },
  modalImage: { width: '92%', height: '70%' },
  modalFailed: { alignItems: 'center', gap: 10 },
  modalFailedText: { color: 'rgba(255,255,255,0.75)', fontSize: fontSize.sm },
  modalRetry: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: colors.primary, borderRadius: radius.full, paddingHorizontal: spacing.lg, paddingVertical: 10, marginTop: spacing.sm },
  modalRetryText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
});
