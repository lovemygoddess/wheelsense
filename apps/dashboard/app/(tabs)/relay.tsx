/**
 * 中继远控 tab —— 尾箱里那台 S7 的"遥控器"。
 *
 * 三块常驻内容：
 *  1) 环境温湿度：米家温湿度计（pvvx 固件 0x181A 广播）→ S7 被动扫描 → env_samples。
 *     注意这是车库/尾箱环境温湿度，与电池温度、S7 自身电池温度是三个独立量。
 *  2) 中继手机自身状态：在线/离线、电量、温度（同样不是电池数据）。
 *  3) 远控台：截图、重启中继 App、重启手机、清理积压、
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
  ActivityIndicator, Alert, Animated, BackHandler, GestureResponderEvent, Image, Modal,
  Pressable, RefreshControl, ScrollView, StyleSheet, Switch, TextInput, View,
} from 'react-native';
import { AppText } from '../../src/components/AppText';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused, usePathname, useRouter } from 'expo-router';
import { useAuth } from '../../src/auth';
import {
  fetchRelayApkInfo, fetchRelayCommands, fetchRelayStatus, getBaseUrl,
  getRelayConfig, issueRelayCommand, rewriteToBase, setRelayConfig,
} from '../../src/api';
import { getTempWarnC, getTempDangerC } from '../../src/widgetData';
import type { RelayCommand, RelayConfigData, RelayStatus } from '../../src/types';
import type { RelayApkInfo } from '../../src/types';
import { Card } from '../../src/components/Card';
import { EmptyState } from '../../src/components/EmptyState';
import { Grid } from '../../src/components/Grid';
import { MetricTile } from '../../src/components/MetricTile';
import { SectionHeader } from '../../src/components/SectionHeader';
import { StatusPill } from '../../src/components/StatusPill';
import { FadeIn } from '../../src/components/Motion';
import { useHeaderTheme } from '../../src/hooks/useHeaderTheme';
import { BackButton } from '../../src/components/BackButton';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useStagger, enterStyle } from '../../src/hooks/useStagger';
import { colors, fontMono, fontSize, headerThemes, radius, shadow, spacing, tint } from '../../src/theme';
import { useAppTheme } from '../../src/ThemeProvider';
import { useVehicleData } from '../../src/vehicleData';
import { useDemoMode } from '../../src/demo/DemoModeProvider';
import { compareRelayVersions, relayVersionLabel, type RelayVersionState } from '../../src/relayVersion';

/** 中继轮询间隔 15s，留足两轮 + 上传时间再判超时。 */
const CMD_POLL_MS = 3_000;
const STATUS_POLL_MS = 10_000;
const RIDE_INTERVALS_MS = [1000, 2000, 3000, 5000];
const IDLE_INTERVALS_SEC = [30, 60, 120, 300, 600];
const RELAY_POLL_INTERVALS_SEC = [15, 30, 60];
const MONITOR_INTERVALS_SEC = [0, 30, 60, 120, 180, 300, 600];
const RELAY_RECOMMENDED = { idleSec: 120, rideMs: 1000, pollSec: 60, monitorSec: 180 };

/** 指令中文名（历史列表 / 截图镜像提示用）。 */
const CMD_LABEL: Record<string, string> = {
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

export default function RelayScreen({ navigationContext = 'legacy' }: { navigationContext?: 'more' | 'legacy' } = {}) {
  const { unlocked } = useAuth();
  const { top } = useHeaderTheme(headerThemes.relay);
  const rs = useResponsive();
  const { colors: themeColors } = useAppTheme();
  const { isDemoMode } = useDemoMode();
  const pathname = usePathname();
  const router = useRouter();
  const isFocused = useIsFocused();
  const { selectedSn: deviceSn, loading: vehicleLoading } = useVehicleData();

  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [relayLatest, setRelayLatest] = useState<RelayApkInfo | null>(null);
  const relayLatestLoadedAtRef = useRef(0);
  const [relayConfig, setRelayConfigState] = useState<RelayConfigData | null>(null);
  const [idleSec, setIdleSec] = useState(RELAY_RECOMMENDED.idleSec);
  const [rideMs, setRideMs] = useState(RELAY_RECOMMENDED.rideMs);
  const [pollSec, setPollSec] = useState(RELAY_RECOMMENDED.pollSec);
  const [monitorSec, setMonitorSec] = useState(RELAY_RECOMMENDED.monitorSec);
  const [lowPower, setLowPower] = useState(true);
  const [thermoMac, setThermoMac] = useState('');
  const [savingRelayConfig, setSavingRelayConfig] = useState(false);
  const [relayConfigMessage, setRelayConfigMessage] = useState<string | null>(null);
  const [relayConfigError, setRelayConfigError] = useState<string | null>(null);
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
  const [relaySettingsOpen, setRelaySettingsOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [relayUpdateState, setRelayUpdateState] = useState<'idle' | 'waiting-heartbeat' | 'updated' | 'failed' | 'unconfirmed'>('idle');
  const [relayUpdateMessage, setRelayUpdateMessage] = useState<string | null>(null);
  const updatePollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { getBaseUrl().then(setBase).catch(() => {}); }, []);
  const refreshRelayLatest = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - relayLatestLoadedAtRef.current < 60_000) return;
    try {
      const latest = await fetchRelayApkInfo();
      setRelayLatest(latest);
      relayLatestLoadedAtRef.current = now;
    } catch {
      // Preserve the last known release metadata; the current device status
      // remains useful when the metadata endpoint is temporarily unavailable.
    }
  }, []);
  useEffect(() => {
    if (!isFocused) return;
    void refreshRelayLatest(true);
    const timer = setInterval(() => { void refreshRelayLatest(); }, 60_000);
    return () => clearInterval(timer);
  }, [isFocused, refreshRelayLatest]);
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
    if (updatePollRef.current) clearTimeout(updatePollRef.current);
    busyRef.current = false;
  }, []);

  // 切换车辆时不能让上一辆车的轮询结果写进当前页面，也不能继续占用远控锁。
  useEffect(() => {
    commandRunRef.current++;
    if (commandTimerRef.current) clearInterval(commandTimerRef.current);
    if (updatePollRef.current) clearTimeout(updatePollRef.current);
    commandTimerRef.current = null;
    busyRef.current = false;
    setWorking(null);
    setRelay(null);
    setCommands([]);
    setMirror(null);
    setViewerUrl(null);
    setViewerCommandId(null);
    setRelayConfigState(null);
    setRelayUpdateState('idle');
    setRelayUpdateMessage(null);
    if (deviceSn) setLoading(true);
  }, [deviceSn]);

  const load = useCallback(async (isRefresh = false) => {
    if (!deviceSn) return;
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;
    if (isRefresh) setRefreshing(true);
    try {
      const [r, cs, cfg] = await Promise.all([
        fetchRelayStatus(deviceSn),
        fetchRelayCommands(deviceSn).catch(() => [] as RelayCommand[]),
        getRelayConfig(deviceSn).catch(() => null),
      ]);
      if (!isCurrent()) return;
      setRelay(r);
      setCommands(cs.filter(c => c.command !== 'photo'));
      if (cfg) {
        setRelayConfigState(cfg);
        setIdleSec(Math.max(1, Math.round(cfg.idle_ms / 1000)));
        setRideMs(cfg.ride_ms);
        setLowPower(cfg.low_power);
        setThermoMac(cfg.thermo_mac ?? '');
        setPollSec(Math.max(1, Math.round(cfg.poll_ms / 1000)));
        setMonitorSec(cfg.monitor_secs);
        setRelayConfigError(null);
      } else {
        setRelayConfigError('中继配置暂时无法读取，保留当前页面值');
      }
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
      setCommands(cs.filter(c => c.command !== 'photo'));
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
            setCommands(cs.filter(c => c.command !== 'photo'));
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

  const saveRelayConfig = useCallback(async () => {
    if (!deviceSn) return;
    const mac = thermoMac.trim();
    if (!isDemoMode && mac !== '' && !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)) {
      setRelayConfigError('温湿度计 MAC 格式应为 AA:BB:CC:DD:EE:FF');
      return;
    }
    setSavingRelayConfig(true);
    setRelayConfigError(null);
    setRelayConfigMessage(null);
    try {
      const normalizedMac = mac === '' ? null : mac.toUpperCase();
      const previousMac = relayConfig?.thermo_mac?.toUpperCase() ?? null;
      const payload: Parameters<typeof setRelayConfig>[1] = {
        idle_ms: idleSec * 1000,
        ride_ms: rideMs,
        low_power: lowPower,
        poll_ms: pollSec * 1000,
        monitor_secs: monitorSec,
      };
      // Do not clear a configured sensor when the field was not edited.
      if (normalizedMac !== previousMac) payload.thermo_mac = normalizedMac;
      const next = await setRelayConfig(deviceSn, payload);
      setRelayConfigState(next);
      setIdleSec(Math.max(1, Math.round(next.idle_ms / 1000)));
      setRideMs(next.ride_ms);
      setLowPower(next.low_power);
      setThermoMac(next.thermo_mac ?? '');
      setPollSec(Math.max(1, Math.round(next.poll_ms / 1000)));
      setMonitorSec(next.monitor_secs);
      setRelayConfigMessage(isDemoMode
        ? '演示模式：已更新演示值，不会写入服务器或真实中继。'
        : relay?.connected === false
          ? '已保存；中继当前离线，重新联网后会在配置轮询时生效。'
          : '已保存；中继下一次配置轮询后生效。');
    } catch (e) {
      setRelayConfigError(e instanceof Error ? e.message : '保存中继配置失败');
    } finally {
      setSavingRelayConfig(false);
    }
  }, [deviceSn, idleSec, isDemoMode, lowPower, monitorSec, pollSec, relay?.connected, relayConfig, rideMs, thermoMac]);

  const restoreRecommendedRelay = useCallback(() => {
    setIdleSec(RELAY_RECOMMENDED.idleSec);
    setRideMs(RELAY_RECOMMENDED.rideMs);
    setPollSec(RELAY_RECOMMENDED.pollSec);
    setMonitorSec(RELAY_RECOMMENDED.monitorSec);
    setLowPower(true);
    setRelayConfigMessage('已恢复推荐值；请点击保存后才会下发到服务器。');
    setRelayConfigError(null);
  }, []);

  const relayVersionState: RelayVersionState = compareRelayVersions(
    { versionName: relay?.connected ? relay.app_ver : null, versionCode: relay?.connected ? relay.version_code : null },
    { versionName: relayLatest?.latest_version_name, versionCode: relayLatest?.latest_version_code },
  );
  const currentRelayVersionLabel = relayVersionLabel(relay?.connected ? relay.app_ver : null, relay?.connected ? relay.version_code : null);
  const latestRelayVersionLabel = relayVersionLabel(relayLatest?.latest_version_name, relayLatest?.latest_version_code);

  const waitForRelayVersion = useCallback(async (baseline: RelayStatus | null, target: RelayApkInfo | null) => {
    if (!deviceSn) return;
    setRelayUpdateState('waiting-heartbeat');
    setRelayUpdateMessage('更新命令已完成，等待中继重新上线确认版本…');
    const startedAt = Date.now();
    const poll = async (): Promise<void> => {
      try {
        const next = await fetchRelayStatus(deviceSn);
        setRelay(next);
        const targetName = target?.latest_version_name ?? null;
        const targetCode = target?.latest_version_code ?? null;
        const targetReached = targetCode !== null
          && next.version_code === targetCode
          && (targetName === null || next.app_ver === targetName)
          && (baseline?.version_code !== targetCode || baseline?.app_ver !== targetName);
        if (targetReached) {
          setRelayUpdateState('updated');
          setRelayUpdateMessage(`中继已更新至 ${relayVersionLabel(next.app_ver, next.version_code)}（已由新心跳确认）`);
          return;
        }
      } catch {
        // Keep waiting; the relay may be restarting during installation.
      }
      if (Date.now() - startedAt >= 180_000) {
        setRelayUpdateState('unconfirmed');
        setRelayUpdateMessage('更新命令已完成，但尚未从心跳确认目标版本；请稍后刷新，未把命令完成误判为升级成功。');
        return;
      }
      updatePollRef.current = setTimeout(() => { void poll(); }, STATUS_POLL_MS);
    };
    await poll();
  }, [deviceSn]);

  const startRelayUpdate = useCallback(async () => {
    if (!deviceSn || busy || relayUpdateState === 'waiting-heartbeat') return;
    if (relayVersionState !== 'UPDATE_AVAILABLE' || !relayLatest?.latest_version_code) return;
    const baseline = relay;
    const target = relayLatest;
    setRelayUpdateState('idle');
    setRelayUpdateMessage('准备更新…');
    const command = await runCommand('update_apk', {}, { timeoutMs: 90_000 });
    if (!command) {
      setRelayUpdateState('failed');
      setRelayUpdateMessage('更新指令未完成，请查看指令历史中的真实错误。');
      return;
    }
    if (command.status !== 'done') {
      setRelayUpdateState('failed');
      setRelayUpdateMessage(command.error || '中继未报告更新指令成功。');
      return;
    }
    await waitForRelayVersion(baseline, target);
  }, [busy, deviceSn, relay, relayLatest, relayUpdateState, relayVersionState, runCommand, waitForRelayVersion]);

  const confirmRelayUpdate = useCallback(() => {
    if (isDemoMode) {
      Alert.alert('演示模式', '演示模式：不会执行真实设备操作。');
      return;
    }
    Alert.alert(
      '更新中继固件',
      '中继将从服务器下载已发布的最新 Relay APK 并安装。更新过程中中继服务会暂时离线，请确认服务器上的更新包已经准备好。',
      [
        { text: '取消', style: 'cancel' },
        { text: '开始更新', onPress: () => { void startRelayUpdate(); } },
      ],
    );
  }, [isDemoMode, startRelayUpdate]);

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
  const activeCommand = commands.find(c => c.status === 'pending' || c.status === 'dispatched') ?? null;

  // The legacy top-level /relay entry can still be reached from old deep links
  // and installs. It is not a child of More's nested stack, so router.back()
  // would pop to whichever tab happened to be underneath (often Overview).
  // Keep the canonical More route's normal stack pop, but return legacy entry
  // points to the Settings root explicitly.
  const handleBack = useCallback(() => {
    if (navigationContext === 'more') {
      // Pop the More-owned stack back to its index.  dismissTo performs a
      // stack pop (and only falls back to the target route when a legacy deep
      // link did not create a More stack entry); it never switches to Overview.
      router.dismissTo('/(tabs)/more');
      return;
    }
    if (pathname === '/relay' || pathname === '/(tabs)/relay') {
      router.replace('/(tabs)/settings');
      return;
    }
    router.back();
  }, [navigationContext, pathname, router]);

  useEffect(() => {
    if (navigationContext !== 'more' || !isFocused) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBack();
      return true;
    });
    return () => sub.remove();
  }, [handleBack, isFocused, navigationContext]);

  if (!deviceSn && (loading || vehicleLoading)) {
    return (
      <ScrollView style={[s.container, { backgroundColor: themeColors.background }]} contentContainerStyle={{ padding: rs.pagePad, paddingTop: top }}>
        <BackButton onPress={handleBack} />
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
      <BackButton onPress={handleBack} />
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
              且 MAC 与中继设置里填写的传感器地址一致。
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
          <View style={s.relayMetaRow}>
            <AppText style={[s.relayMetaText, { color: themeColors.textMuted }]}>保护板：{relay?.board_state === 'live' ? '实时' : relay?.board_state === 'connected_stale' ? '已连接·待同步' : relay?.board_state === 'disconnected' ? '未连接' : '—'}</AppText>
            <AppText style={[s.relayMetaText, { color: themeColors.textMuted }]}>Relay App：{relay?.app_ver ?? '—'}</AppText>
          </View>
        </Card>
      </Animated.View>

      {/* ── 3. Relay 配置：正常状态的基础频率 ── */}
      <Card style={s.card}>
        <Pressable onPress={() => setRelaySettingsOpen(v => !v)} style={s.cardHead} accessibilityRole="button" accessibilityLabel="展开或收起中继设置">
          <View style={s.cardTitleWrap}>
            <Ionicons name="options-outline" size={18} color={themeColors.primary} />
            <View>
              <AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>中继设置</AppText>
              {!relaySettingsOpen && <AppText style={[s.configHintSmall, { color: themeColors.textMuted }]}>已连接 · 自动同步 · 电源保护状态见下方</AppText>}
            </View>
          </View>
          <View style={s.cardHeadRight}>
            <StatusPill
              label={relayConfig ? '已读取' : '读取中'}
              icon={relayConfig ? 'checkmark-circle-outline' : 'time-outline'}
              fg={relayConfig ? themeColors.textSecondary : themeColors.textMuted}
              bg={themeColors.surfaceSecondary}
            />
            <Ionicons name={relaySettingsOpen ? 'chevron-up' : 'chevron-down'} size={17} color={themeColors.textMuted} />
          </View>
        </Pressable>
        {relaySettingsOpen && <>
        <AppText style={[s.configHint, { color: themeColors.textMuted }]}>以下是正常状态的基础采样 / 轮询值。骑行、充电候选、稳定充电和结束确认时，中继会自动临时提高频率（约 10–15 秒），不会被这些基础设置关闭。</AppText>
        <AppText style={[s.configGroupLabel, { color: themeColors.textMuted }]}>数据与同步</AppText>

        <RelayPresetField
          label="骑行时采样间隔"
          value={rideMs}
          options={RIDE_INTERVALS_MS}
          recommended={RELAY_RECOMMENDED.rideMs}
          format={formatRideInterval}
          onChange={setRideMs}
        />
        <RelayPresetField
          label="停车时保存 / 上传间隔"
          value={idleSec}
          options={IDLE_INTERVALS_SEC}
          recommended={RELAY_RECOMMENDED.idleSec}
          format={formatSecondsCompact}
          onChange={setIdleSec}
        />
        <RelayPresetField
          label="中继与服务器轮询间隔"
          value={pollSec}
          options={RELAY_POLL_INTERVALS_SEC}
          recommended={RELAY_RECOMMENDED.pollSec}
          format={value => `${value} 秒`}
          onChange={setPollSec}
        />
        <RelayPresetField
          label="停车后高频监测时长"
          value={monitorSec}
          options={MONITOR_INTERVALS_SEC}
          recommended={RELAY_RECOMMENDED.monitorSec}
          format={formatSecondsCompact}
          onChange={setMonitorSec}
        />
        <AppText style={[s.configGroupLabel, { color: themeColors.textMuted }]}>电源管理（只读状态）</AppText>
        <KeepAliveSummary status={parseKeepAliveStatus(relay?.ble_status)} />
        <View style={s.configToggleRow}>
          <View style={{ flex: 1, paddingRight: spacing.sm }}>
            <AppText style={[s.configLabel, { color: themeColors.textPrimary }]}>增强省电模式</AppText>
            <AppText style={[s.configHintSmall, { color: themeColors.textMuted }]}>降低停车网络与传感器扫描功耗，不降低保护板保活和充电候选监测。</AppText>
          </View>
          <Switch value={lowPower} onValueChange={setLowPower} trackColor={{ false: themeColors.border, true: themeColors.primarySoft }} thumbColor={lowPower ? themeColors.primary : themeColors.textDim} />
        </View>
        <AppText style={[s.configLabel, { color: themeColors.textPrimary }]}>温湿度计 MAC（可选）</AppText>
        <TextInput
          style={[s.configInput, { color: themeColors.textPrimary, backgroundColor: themeColors.surfaceSecondary, borderColor: themeColors.border }]}
          value={thermoMac}
          onChangeText={setThermoMac}
          placeholder="AA:BB:CC:DD:EE:FF"
          placeholderTextColor={themeColors.textDim}
          autoCapitalize="characters"
        />
        <AppText style={[s.configHintSmall, { color: themeColors.textMuted }]}>留空则不采集环境温湿度。服务器返回的 upload_ms 是实时上行节流，由骑行 / GPS 状态动态调整，不在此重复设置。</AppText>
        <AppText style={[s.configGroupLabel, { color: themeColors.textMuted }]}>诊断（只读）</AppText>
        <AppText style={[s.configHintSmall, { color: themeColors.textMuted }]} numberOfLines={3}>{relay?.ble_status ?? '等待中继心跳诊断…'}</AppText>
        <Pressable style={[s.configPrimaryButton, { backgroundColor: themeColors.primary }, savingRelayConfig && { opacity: 0.55 }]} onPress={() => { void saveRelayConfig(); }} disabled={savingRelayConfig}>
          <AppText style={s.configPrimaryButtonText}>{savingRelayConfig ? '保存中…' : '保存中继配置'}</AppText>
        </Pressable>
        <Pressable style={[s.configSecondaryButton, { borderColor: themeColors.border }]} onPress={restoreRecommendedRelay}>
          <AppText style={[s.configSecondaryButtonText, { color: themeColors.primary }]}>恢复推荐值（仅回填）</AppText>
        </Pressable>
        {relayConfigMessage ? <AppText style={[s.configMessage, { color: themeColors.textSecondary }]}>{relayConfigMessage}</AppText> : null}
        {relayConfigError ? <AppText style={[s.configMessage, { color: themeColors.danger }]}>{relayConfigError}</AppText> : null}
        </>}
      </Card>

      {/* ── 4. 软件与固件 ── */}
      <Card style={s.card}>
        <View style={s.cardHead}>
          <View style={s.cardTitleWrap}>
            <Ionicons name="cloud-download-outline" size={18} color={themeColors.primary} />
            <AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>软件与固件</AppText>
          </View>
        </View>
        <View style={[s.versionRow, { backgroundColor: themeColors.surfaceSecondary }]}>
          <View style={{ flex: 1 }}>
            <AppText style={[s.configLabel, { color: themeColors.textPrimary }]}>Relay 固件</AppText>
            <AppText style={[s.versionValue, { color: themeColors.primary }]}>
              {relayVersionState === 'UPDATE_AVAILABLE' ? `${latestRelayVersionLabel} 可更新` :
                relayVersionState === 'UP_TO_DATE' ? latestRelayVersionLabel :
                  relayVersionState === 'DEVICE_NEWER_THAN_SERVER' ? currentRelayVersionLabel :
                    relayVersionState === 'UNKNOWN_LATEST_VERSION' ? '服务器最新版本暂无法获取' :
                      '当前版本暂无法获取'}
            </AppText>
          </View>
          <Ionicons name="hardware-chip-outline" size={24} color={themeColors.primary} />
        </View>
        <AppText style={[s.configHintSmall, { color: themeColors.textMuted }]}>当前版本来自 S7 最新心跳；服务器版本来自 Relay latest 发布元数据。版本比较只使用 versionCode。</AppText>
        <View style={s.relayMetaRow}>
          <AppText style={[s.relayMetaText, { color: themeColors.textMuted }]}>当前：{currentRelayVersionLabel}</AppText>
          <AppText style={[s.relayMetaText, { color: themeColors.textMuted }]}>服务器：{latestRelayVersionLabel}</AppText>
        </View>
        {relayVersionState === 'UPDATE_AVAILABLE' && (
          <Pressable
            style={[s.configPrimaryButton, { backgroundColor: themeColors.primary }, (busy || relayUpdateState === 'waiting-heartbeat') && { opacity: 0.55 }]}
            onPress={confirmRelayUpdate}
            disabled={busy || relayUpdateState === 'waiting-heartbeat'}
          >
            <Ionicons name="download-outline" size={16} color="#fff" />
            <AppText style={s.configPrimaryButtonText}>{relayUpdateState === 'waiting-heartbeat' ? '等待新心跳确认…' : '立即更新'}</AppText>
          </Pressable>
        )}
        {relayVersionState === 'UP_TO_DATE' && <AppText style={[s.configMessage, { color: themeColors.textSecondary }]}>已是最新版本</AppText>}
        {relayVersionState === 'DEVICE_NEWER_THAN_SERVER' && <AppText style={[s.configMessage, { color: themeColors.textMuted }]}>设备版本较新，不提供默认降级。</AppText>}
        {relayUpdateMessage ? <AppText style={[s.configMessage, { color: relayUpdateState === 'failed' ? themeColors.danger : relayUpdateState === 'updated' ? themeColors.textSecondary : themeColors.textMuted }]}>{relayUpdateMessage}</AppText> : null}
      </Card>

      {/* ── 5. 命令执行状态 ── */}
      <Animated.View style={enterStyle(anims[2])}>
        <Card style={s.card}>
          <View style={s.cardHead}>
            <View style={{ flex: 1 }}>
              <View style={s.cardTitleWrap}>
                <Ionicons name="pulse-outline" size={18} color={themeColors.primary} />
                <AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>命令执行状态</AppText>
              </View>
              <AppText style={[s.configHintSmall, { color: themeColors.textMuted }]}>
                {working ? (working.stage || '执行中…') : activeCommand ? `${CMD_LABEL[activeCommand.command] ?? activeCommand.command} · ${statusLabel(activeCommand.status)}` : '暂无正在执行的命令'}
              </AppText>
            </View>
            {busy && (
              <ActivityIndicator size="small" color={themeColors.primary} />
            )}
          </View>

          {busy && (
            <View style={[s.commandProgressWrap, { backgroundColor: themeColors.surfaceSecondary }]}>
              <View style={s.heroBtnRow}>
                <ActivityIndicator size="small" color={themeColors.primary} />
                <AppText style={[s.heroBtnText, { color: themeColors.primary }]}>{working?.stage || '执行中…'}</AppText>
              </View>
              <CommandProgress phase={working?.phase ?? 'issuing'} />
            </View>
          )}

          {!busy && activeCommand && (
            <AppText style={[s.footNote, { color: themeColors.textMuted }]}>
              提交于 {fmtTime(activeCommand.created_at)} · {connected ? '中继在线，等待状态更新' : '中继离线，等待恢复联网'}
            </AppText>
          )}
        </Card>
      </Animated.View>

      <Card style={s.card}>
        <Pressable onPress={() => setDeveloperOpen(v => !v)} style={s.advancedToggle}>
          <View style={[s.advancedIcon, { backgroundColor: themeColors.primarySoft }]}><Ionicons name="construct-outline" size={18} color={themeColors.primary} /></View>
          <View style={{ flex: 1 }}><AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>高级远控</AppText><AppText style={[s.advancedSub, { color: themeColors.textMuted }]}>命令、日志与诊断工具</AppText></View>
          <Ionicons name={developerOpen ? 'chevron-up' : 'chevron-down'} size={17} color={themeColors.textMuted} />
        </Pressable>
      </Card>

      {developerOpen && <>
      <Card style={s.card}>
        <Pressable onPress={() => setCommandsOpen(v => !v)} style={s.advancedToggle} accessibilityRole="button" accessibilityLabel="展开或收起命令">
          <View style={[s.advancedIcon, { backgroundColor: themeColors.primarySoft }]}><Ionicons name="terminal-outline" size={18} color={themeColors.primary} /></View>
          <View style={{ flex: 1 }}><AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>命令</AppText><AppText style={[s.advancedSub, { color: themeColors.textMuted }]}>截图、系统维护与安全按键</AppText></View>
          <Ionicons name={commandsOpen ? 'chevron-up' : 'chevron-down'} size={17} color={themeColors.textMuted} />
        </Pressable>
      </Card>
      {commandsOpen && <>
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

      </>}

      <Card style={s.card}>
        <Pressable onPress={() => setLogsOpen(v => !v)} style={s.advancedToggle} accessibilityRole="button" accessibilityLabel="展开或收起日志">
          <View style={[s.advancedIcon, { backgroundColor: themeColors.primarySoft }]}><Ionicons name="list-outline" size={18} color={themeColors.primary} /></View>
          <View style={{ flex: 1 }}><AppText style={[s.cardTitle, { color: themeColors.textPrimary }]}>日志</AppText><AppText style={[s.advancedSub, { color: themeColors.textMuted }]}>命令与连接事件历史</AppText></View>
          <Ionicons name={logsOpen ? 'chevron-up' : 'chevron-down'} size={17} color={themeColors.textMuted} />
        </Pressable>
      </Card>
      {logsOpen && <>
      <SectionHeader
        icon="time-outline"
        title="命令日志"
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

}

function RelayPresetField({ label, value, options, recommended, format, onChange }: {
  label: string;
  value: number;
  options: number[];
  recommended: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const { colors: c } = useAppTheme();
  return (
    <View style={s.presetField}>
      <View style={s.presetFieldHead}>
        <AppText style={[s.configLabel, { color: c.textPrimary }]}>{label}</AppText>
        <AppText style={[s.presetValue, { color: c.primary }]}>{format(value)}</AppText>
      </View>
      <View style={s.presetOptions}>
        {options.map(option => {
          const selected = option === value;
          return (
            <Pressable
              key={option}
              onPress={() => onChange(option)}
              style={[s.presetOption, { borderColor: selected ? c.primary : c.border, backgroundColor: selected ? c.primarySoft : c.surfaceSecondary }]}
            >
              <AppText style={[s.presetOptionText, { color: selected ? c.primary : c.textMuted }]}>{format(option)}</AppText>
            </Pressable>
          );
        })}
      </View>
      <Pressable onPress={() => onChange(recommended)} hitSlop={6}>
        <AppText style={[s.recommendedText, { color: c.textMuted }]}>推荐 {format(recommended)}</AppText>
      </Pressable>
    </View>
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

function statusLabel(status: string): string {
  return STATUS_TONE[status]?.label ?? status;
}

type KeepAliveStatus = {
  ext: string;
  battery: string;
  charging: string;
  temp: string;
  ka: string;
  wakeLock: string;
  pulseAge: string;
  pulseCount: string;
  delayMax: string;
};

function parseKeepAliveStatus(raw: string | null | undefined): KeepAliveStatus | null {
  if (!raw) return null;
  const power = raw.match(/PWR:([^ ]+)/)?.[1] ?? raw;
  return {
    ext: takeFrom(power, 'ext'),
    battery: takeFrom(power, 'bat'),
    charging: takeFrom(power, 'chg'),
    temp: takeFrom(power, 'temp'),
    ka: takeFrom(power, 'KA'),
    wakeLock: takeFrom(power, 'WL'),
    pulseAge: takeFrom(power, 'pulseAge'),
    pulseCount: takeFrom(power, 'pc'),
    delayMax: takeFrom(power, 'delayMax'),
  };
}

function takeFrom(raw: string, key: string): string {
  return raw.match(new RegExp(`${key}=([^,\\s]+)`))?.[1] ?? '—';
}

function KeepAliveSummary({ status }: { status: KeepAliveStatus | null }) {
  const { colors: c } = useAppTheme();
  if (!status) return <AppText style={[s.configHintSmall, { color: c.textMuted }]}>等待 Relay V2 心跳诊断…</AppText>;
  return (
    <View style={[s.keepAliveBox, { backgroundColor: c.surfaceSecondary, borderColor: c.borderSubtle }]}>
      <View style={s.keepAliveRow}>
        <AppText style={[s.keepAliveLabel, { color: c.textMuted }]}>Keep-Alive</AppText>
        <AppText style={[s.keepAliveValue, { color: status.ka === 'ON' ? c.textSecondary : c.textMuted }]}>{status.ka} · WL {status.wakeLock}</AppText>
      </View>
      <View style={s.keepAliveRow}>
        <AppText style={[s.keepAliveLabel, { color: c.textMuted }]}>供电 / 电量</AppText>
        <AppText style={[s.keepAliveValue, { color: c.textPrimary }]}>{status.ext === '1' ? '外部供电' : '未检测到外部供电'} · {status.battery}% · {status.temp}°C</AppText>
      </View>
      <View style={s.keepAliveRow}>
        <AppText style={[s.keepAliveLabel, { color: c.textMuted }]}>脉冲 / 调度</AppText>
        <AppText style={[s.keepAliveValue, { color: c.textPrimary }]}>age {status.pulseAge}s · #{status.pulseCount} · max {status.delayMax}ms</AppText>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  card: { marginBottom: spacing.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  cardHeadRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  relayHealth: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  relayHealthIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  relayHealthTitle: { fontSize: fontSize.md, fontWeight: '800' },
  relayHealthText: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.borderLight, marginVertical: spacing.sm },
  footNote: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', marginTop: spacing.md, lineHeight: 16 },
  relayMetaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, marginTop: spacing.sm },
  relayMetaText: { flex: 1, fontSize: fontSize.xs, lineHeight: 16 },
  configHint: { fontSize: fontSize.xs, lineHeight: 17, marginBottom: spacing.md },
  configHintSmall: { fontSize: fontSize.xs, lineHeight: 16, marginTop: 5 },
  configGroupLabel: { fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 0.4, marginTop: spacing.md, marginBottom: spacing.xs },
  configLabel: { fontSize: fontSize.sm, fontWeight: '700' },
  configInput: { borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: spacing.md, paddingVertical: 10, marginTop: spacing.xs, fontSize: fontSize.sm, fontFamily: fontMono },
  configToggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  configPrimaryButton: { minHeight: 44, borderRadius: radius.lg, marginTop: spacing.md, paddingHorizontal: spacing.md, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  configPrimaryButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
  configSecondaryButton: { minHeight: 42, borderWidth: 1, borderRadius: radius.lg, marginTop: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  configSecondaryButtonText: { fontSize: fontSize.sm, fontWeight: '600' },
  configMessage: { fontSize: fontSize.xs, lineHeight: 16, marginTop: spacing.sm },
  keepAliveBox: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.sm, marginBottom: spacing.sm },
  keepAliveRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: 4 },
  keepAliveLabel: { fontSize: fontSize.xs },
  keepAliveValue: { flex: 1, textAlign: 'right', fontSize: fontSize.xs, fontFamily: fontMono, fontWeight: '700' },
  presetField: { marginBottom: spacing.md },
  presetFieldHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  presetValue: { fontSize: fontSize.sm, fontWeight: '800', fontFamily: fontMono },
  presetOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  presetOption: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: 7 },
  presetOptionText: { fontSize: fontSize.xs, fontWeight: '600' },
  recommendedText: { alignSelf: 'flex-end', fontSize: fontSize.xs, marginTop: spacing.xs },
  versionRow: { borderRadius: radius.lg, padding: spacing.md, flexDirection: 'row', alignItems: 'center' },
  versionValue: { fontSize: fontSize.xl, fontWeight: '800', fontFamily: fontMono, marginTop: 3 },
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
