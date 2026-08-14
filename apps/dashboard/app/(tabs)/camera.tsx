import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  Image,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppText } from '../../src/components/AppText';
import { useIsFocused } from 'expo-router';
import * as IntentLauncher from 'expo-intent-launcher';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from '../../src/components/LinearGradient';
import { EmptyState } from '../../src/components/EmptyState';
import { Grid } from '../../src/components/Grid';
import { SectionHeader } from '../../src/components/SectionHeader';
import { useHeaderTheme } from '../../src/hooks/useHeaderTheme';
import { BackButton } from '../../src/components/BackButton';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useStagger, enterStyle } from '../../src/hooks/useStagger';
import { FadeIn, PressScale, Pulse } from '../../src/components/Motion';
import { InfoHint } from '../../src/components/InfoHint';
import { colors, fontSize, headerThemes, radius, shadow, spacing, tint } from '../../src/theme';
import { fetchEzvizDevices, fetchEzvizAlarms, captureSnapshot } from '../../src/api';
import type { AlarmItem } from '../../src/api';
import { useAppTheme } from '../../src/ThemeProvider';
import { useDemoMode } from '../../src/demo/DemoModeProvider';

const EZVIZ_PACKAGE = 'com.videogo';
const ALARM_TYPE_LABELS: Record<string, string> = {
  '10120': '移动侦测',
  '10110': '人形检测',
  '10000': '通用告警',
};

export default function CameraScreen() {
  const { top } = useHeaderTheme(headerThemes.camera);
  const rs = useResponsive();
  const { colors: c } = useAppTheme();
  const { isDemoMode } = useDemoMode();
  const [camera, setCamera] = useState<any>(null);
  const [alarms, setAlarms] = useState<AlarmItem[]>([]);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [snapshotVisible, setSnapshotVisible] = useState(false);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const devices = await fetchEzvizDevices();
      if (devices === null) {
        setNotConfigured(true);
        setCamera(null);
        setAlarms([]);
        return;
      }
      setNotConfigured(false);
      // Never bake a real camera serial into the public client. The account's
      // first device is the default; users with multiple cameras can select
      // one through the server/account configuration.
      const cam = devices[0] ?? null;
      setCamera(cam);
      const alarmList = cam ? await fetchEzvizAlarms(cam.deviceSerial, 30) : [];
      setAlarms(alarmList ?? []);
    } catch (e: any) {
      setError(e?.message ?? '加载失败，请检查网络和服务器状态');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // 静默轮询：其它 tab 都有 5-60s 自动刷新，监控页此前只能手动下拉。
  // 仅在本页可见且 App 处于前台时轮询——切到别的 tab 或退到后台还继续每 60s
  // 打萤石接口是纯粹的电量/流量浪费。
  const isFocused = useIsFocused();
  const appActiveRef = useRef(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      appActiveRef.current = state === 'active';
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!isFocused) return;
    const t = setInterval(() => {
      if (appActiveRef.current) void loadData(true);
    }, 60000);
    return () => clearInterval(t);
  }, [loadData, isFocused]);

  const openEzvizApp = useCallback(async () => {
    if (isDemoMode) {
      Alert.alert('演示模式', '演示模式：不会打开或操作真实监控设备。');
      return;
    }
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
        packageName: 'com.videogo',
        className: 'com.videogo.LauncherActivity',
        flags: 0x10200000, // NEW_TASK | RESET_TASK_IF_NEEDED
      });
      return;
    } catch {}
    try {
      await Linking.openURL('videogo://');
      return;
    } catch {}
    Alert.alert('未安装萤石云', '请先安装萤石云视频 App。', [
      { text: '取消', style: 'cancel' },
      // R9: openURL rejects when no handler exists — never let it float.
      { text: '下载 APK', onPress: () => { void Linking.openURL('https://appdownload.ys7.com/shipin7.apk').catch(() => {}); } },
    ]);
  }, [isDemoMode]);

  const handleCapture = useCallback(async () => {
    if (isDemoMode) {
      Alert.alert('演示模式', '演示模式：不会执行真实设备操作。');
      return;
    }
    const serial = camera?.deviceSerial;
    if (!serial) return;
    setCapturing(true);
    flashAnim.setValue(0.75);
    Animated.timing(flashAnim, { toValue: 0, duration: 450, useNativeDriver: true, easing: Easing.out(Easing.ease) }).start();
    try {
      const url = await captureSnapshot(serial);
      if (url) {
        setSnapshotUrl(url);
        setSnapshotFailed(false);
        setSnapshotVisible(true);
      } else {
        Alert.alert('抓拍失败', '摄像头可能离线或正在休眠，请稍后重试');
      }
    } catch (e: any) {
      Alert.alert('抓拍失败', e?.message ?? '请确认摄像头在线');
    } finally {
      setCapturing(false);
    }
  }, [camera?.deviceSerial, isDemoMode]);

  /** Shared open-viewer helper — resets the failure flag every time. */
  const openViewer = useCallback((url: string) => {
    setSnapshotUrl(url);
    setSnapshotFailed(false);
    setSnapshotVisible(true);
  }, []);

  const online = isDemoMode || camera?.status === 1;
  const statusText = isDemoMode ? '演示' : online ? '在线' : '离线';
  const statusColor = online ? c.success : c.danger;
  const alarmCols = rs.gridCols(160);
  const groupedAlarms = useMemo(() => {
    const map = new Map<string, { label: string; items: AlarmItem[] }>();
    for (const a of alarms) {
      const key = a.time ? a.time.split(' ')[0] : '';
      const label = a.time ? fmtAlarmDay(a.time) : '未知时间';
      let g = map.get(key);
      if (!g) { g = { label, items: [] }; map.set(key, g); }
      g.items.push(a);
    }
    const arr = [...map.entries()];
    arr.sort((x, y) => {
      if (x[0] === '') return 1;
      if (y[0] === '') return -1;
      return y[0] < x[0] ? -1 : y[0] > x[0] ? 1 : 0;
    });
    return arr.map(([key, v]) => ({ key, ...v }));
  }, [alarms]);
  const anims = useStagger(2);
  const flashAnim = useRef(new Animated.Value(0)).current;
  const latestPicture = alarms.find(item => !!item.picUrl)?.picUrl ?? null;

  return (
    <ScrollView
      style={[s.container, { backgroundColor: c.background }]}
      contentContainerStyle={{ padding: rs.pagePad, paddingTop: top, paddingBottom: 60 }}
      refreshControl={<RefreshControl tintColor={c.primary} refreshing={refreshing} onRefresh={() => loadData(true)} />}
    >
      <BackButton />
      {loading && !camera && !notConfigured ? (
        <EmptyState
          variant="pulse"
          icon="videocam-outline"
          title="连接萤石云…"
          subtitle="正在拉取摄像头状态与最近告警"
          accent={c.primary}
          accentBg={c.primarySoft}
        />
      ) : notConfigured ? (
        <EmptyState
          variant="float"
          icon="settings-outline"
          title="萤石云未配置"
          subtitle="服务器 .env 缺少 EZVIZ_APP_KEY / EZVIZ_APP_SECRET，配置后重启服务即可"
          accent={c.textSecondary}
          accentBg={c.surfaceSecondary}
        />
      ) : error && !camera ? (
        <EmptyState
          variant="float"
          icon="alert-circle-outline"
          title="加载失败"
          subtitle={error}
          accent={c.danger}
          accentBg={c.dangerSoft}
          actionLabel="重试"
          onAction={() => loadData()}
        />
      ) : !camera ? (
        <EmptyState
          variant="float"
          icon="videocam-off-outline"
          title="未发现摄像头"
          subtitle="萤石账号下没有任何设备，请先在萤石云 App 中添加摄像头"
          accent={c.textSecondary}
          accentBg={c.surfaceSecondary}
          actionLabel="重试"
          onAction={() => loadData()}
        />
      ) : (
        <>
          {/* Latest camera frame is the visual center. */}
          <Animated.View style={enterStyle(anims[0])}>
        <View style={[s.heroCard, { backgroundColor: c.surface, borderColor: c.border }]}>
            <View style={s.heroTop}>
              <View style={s.heroLeft}>
                <AppText style={[s.deviceName, { color: c.textPrimary }]}>车辆监控</AppText>
                <AppText style={[s.deviceSerial, { color: c.textMuted }]}>{camera?.deviceName ?? '哨兵'}</AppText>
              </View>
              {/* 电池电量（电池款摄像头；后端 status/get 的 battryStatus）+ 在线状态 */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {camera?.battery != null && (
                  <View style={[s.statusBadge, { backgroundColor: c.surfaceSecondary }]}>
                    <Ionicons
                      name={camera.battery > 60 ? 'battery-full-outline' : camera.battery > 20 ? 'battery-half-outline' : 'battery-dead-outline'}
                      size={12}
                      color={camera.battery > 20 ? c.textSecondary : c.danger}
                    />
                    <AppText style={[s.statusText, { color: camera.battery > 20 ? c.textSecondary : c.danger }]}>{camera.battery}%</AppText>
                    <InfoHint hintKey="camera_battery" size={13} color={c.textMuted} />
                  </View>
                )}
                <View style={[s.statusBadge, { backgroundColor: online ? c.surfaceSecondary : c.dangerSoft }]}>
                  <Pulse active={online} minOpacity={0.25} scaleTo={1.3}>
                    <View style={[s.statusDot, { backgroundColor: statusColor }]} />
                  </Pulse>
                  <AppText style={[s.statusText, { color: statusColor }]}>{statusText}</AppText>
                </View>
              </View>
            </View>
            <View style={[s.latestFrame, { backgroundColor: c.surfaceSecondary }]}>
              {latestPicture ? <AlarmPic url={latestPicture} latest /> : <View style={s.latestEmpty}><Ionicons name="videocam-outline" size={36} color={c.textDim} /><AppText style={[s.latestEmptyText, { color: c.textMuted }]}>暂无最新画面</AppText></View>}
              <View style={s.latestLabel}><AppText style={s.latestLabelText}>最新画面</AppText></View>
            </View>
            <View style={s.actionRow}>
              <PressScale wrapStyle={{ flex: 1 }}
                min={0.96}
                style={({ pressed }) => [s.btnSecondaryWrap, { backgroundColor: c.primary }, pressed && { opacity: 0.85 }, !online && s.btnDisabled]}
                onPress={handleCapture}
                disabled={!online || capturing}
              >
                <View style={s.btnSecondaryInner}>
                  {capturing ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <AppText style={s.btnSecondaryText}>立即抓拍</AppText>
                  )}
                </View>
              </PressScale>
            </View>
          </View>
          <Animated.View style={[s.flash, { opacity: flashAnim }]} pointerEvents="none" />
        </Animated.View>

          <Animated.View style={enterStyle(anims[1])}>
          {/* Alarm gallery */}
          <SectionHeader
            icon="notifications-outline"
            title="告警记录"
            accessory={alarms.length > 0 ? <AppText style={[s.sectionCount, { color: c.textMuted }]}>共 {alarms.length} 条</AppText> : undefined}
            style={{ marginBottom: spacing.md }}
          />

          {alarms.length === 0 ? (
            <EmptyState
              variant="float"
              icon="camera-outline"
              title="暂无告警记录"
              subtitle="摄像头检测到移动时会自动抓拍"
              accent={c.textSecondary}
              accentBg={c.surfaceSecondary}
            />
          ) : (
            <>
              {groupedAlarms.map(g => (
                <View key={g.key || 'unknown'} style={s.alarmGroup}>
                  <View style={s.dayHeader}>
                    <View style={[s.dayLine, { backgroundColor: c.borderSubtle }]} />
                    <AppText style={[s.dayLabel, { color: c.textMuted }]}>{g.label}</AppText>
                    <View style={[s.dayLine, { backgroundColor: c.borderSubtle }]} />
                  </View>
                  <Grid cols={alarmCols} gap={rs.gridGap}>
                    {g.items.map((item, i) => {
                      const typeLabel = item.type ? (ALARM_TYPE_LABELS[item.type] ?? '告警') : '告警';
                      return (
                        <FadeIn key={item.id ?? i} index={i} style={[s.alarmCard, { backgroundColor: c.surface }]}>
                          <Pressable onPress={() => openViewer(item.picUrl)}>
                            {item.picUrl ? (
                              <AlarmPic url={item.picUrl} />
                            ) : (
                              <View style={[s.noPic, { backgroundColor: c.surfaceSecondary }]}>
                                <AppText style={[s.noPicText, { color: c.textMuted }]}>无图片</AppText>
                              </View>
                            )}
                          </Pressable>
                          <View style={s.alarmInfo}>
                            <View style={[s.alarmBadge, { backgroundColor: c.dangerSoft }]}>
                              <AppText style={[s.alarmBadgeText, { color: c.danger }]}>{typeLabel}</AppText>
                            </View>
                            {item.time && <AppText style={[s.alarmTime, { color: c.textMuted }]}>{item.time}</AppText>}
                          </View>
                        </FadeIn>
                      );
                    })}
                  </Grid>
                </View>
              ))}
            </>
          )}
          <Pressable onPress={openEzvizApp} style={[s.openEzviz, { backgroundColor: c.surface, borderColor: c.border }]}><Ionicons name="open-outline" size={17} color={c.primary} /><AppText style={[s.openEzvizText, { color: c.primary }]}>打开萤石云 App</AppText><Ionicons name="chevron-forward" size={17} color={c.textDim} /></Pressable>
          </Animated.View>
        </>
      )}

      {/* Full-screen snapshot viewer */}
      <Modal visible={snapshotVisible} transparent={true} onRequestClose={() => setSnapshotVisible(false)}>
        <View style={s.modalBg}>
          <Pressable style={s.modalClose} hitSlop={10} onPress={() => setSnapshotVisible(false)}>
            <Ionicons name="close" size={18} color="#fff" />
          </Pressable>
          {snapshotFailed ? (
            <View style={s.modalFailed}>
              <Ionicons name="image-outline" size={40} color="rgba(255,255,255,0.6)" />
              <AppText style={s.modalFailedText}>图片加载失败（链接可能已过期）</AppText>
            </View>
          ) : snapshotUrl ? (
            <Image source={{ uri: snapshotUrl }} style={s.modalImage} resizeMode="contain" onError={() => setSnapshotFailed(true)} />
          ) : (
            <ActivityIndicator size="large" color="#fff" />
          )}
        </View>
      </Modal>
    </ScrollView>
  );
}

/** Alarm thumbnail with an expiry fallback — ezviz pic URLs go stale, and
 *  a dead <Image> used to render as a silent black box (R10).
 *  `isEncrypted=1` URLs are hikencodepicture AES blobs (设备开了视频图片加密),
 *  not JPEG — no client can render them, so say so instead of fetching
 *  guaranteed garbage and reporting a misleading "已过期". */
function AlarmPic({ url, latest = false }: { url: string; latest?: boolean }) {
  const { colors: c } = useAppTheme();
  const [failed, setFailed] = useState(false);
  if (url.includes('isEncrypted=1')) {
    return (
      <View style={[s.noPic, { backgroundColor: c.surfaceSecondary }, latest && s.latestPic]}>
        <AppText style={[s.noPicText, { color: c.textMuted }]}>设备已开启图片加密{'\n'}请在萤石云 App 关闭</AppText>
      </View>
    );
  }
  if (failed) {
    return (
      <View style={[s.noPic, { backgroundColor: c.surfaceSecondary }, latest && s.latestPic]}>
        <AppText style={[s.noPicText, { color: c.textMuted }]}>图片已过期</AppText>
      </View>
    );
  }
  return <Image source={{ uri: url }} style={latest ? s.latestPic : s.alarmPic} resizeMode="cover" onError={() => setFailed(true)} />;
}

/** 告警时间 "MM-DD HH:mm"（上海时区）→ "M月D日 周X"，用于按天分组标题。 */
function fmtAlarmDay(time: string): string {
  const md = time.split(' ')[0] ?? time;
  const parts = md.split('-');
  if (parts.length < 2) return md;
  const month = Number(parts[0]);
  const day = Number(parts[1]);
  const d = new Date(new Date().getFullYear(), month - 1, day);
  if (Number.isNaN(d.getTime())) return md;
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${month}月${day}日 ${wd}`;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  heroCard: {
    borderRadius: radius.xxl,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    borderWidth: 1,
  } as any,
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: spacing.sm },
  heroLeft: { flex: 1 },
  deviceName: { fontSize: fontSize.xl, fontWeight: '800' },
  deviceSerial: { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.7)', marginTop: 2 },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
  } as any,
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 5 },
  statusText: { fontSize: fontSize.sm, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: spacing.lg },
  latestFrame: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.lg, overflow: 'hidden', marginTop: spacing.sm, marginBottom: spacing.md },
  latestEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  latestEmptyText: { fontSize: fontSize.sm },
  latestLabel: { position: 'absolute', left: 10, top: 10, backgroundColor: 'rgba(0,0,0,0.48)', borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  latestLabelText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '700' },
  metaText: { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.85)' },
  metaDivider: { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.6)', marginHorizontal: 4 },
  actionRow: { flexDirection: 'row', gap: spacing.md },
  btnPrimaryWrap: { flex: 1, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.card } as any,
  btnPrimaryInner: { paddingVertical: 13, alignItems: 'center' } as any,
  btnPrimaryText: { color: colors.primary, fontSize: fontSize.md, fontWeight: '700' },
  btnSecondaryWrap: { flex: 1, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.primary } as any,
  btnSecondaryInner: { paddingVertical: 13, alignItems: 'center' } as any,
  btnSecondaryText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },

  sectionCount: { fontSize: fontSize.sm, color: colors.textMuted },
  alarmGroup: { marginBottom: spacing.md },
  dayHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.sm },
  dayLine: { flex: 1, height: 1, backgroundColor: colors.borderLight },
  dayLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  flash: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#ffffff', borderRadius: radius.xxl },

  alarmCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow.subtle,
  } as any,
  alarmPic: { width: '100%', height: 150 },
  latestPic: { width: '100%', height: '100%' },
  openEzviz: { marginTop: spacing.md, minHeight: 50, borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  openEzvizText: { flex: 1, fontSize: fontSize.md, fontWeight: '700' },
  noPic: { width: '100%', height: 150, backgroundColor: colors.cardAlt, justifyContent: 'center', alignItems: 'center' },
  noPicText: { color: colors.textMuted, fontSize: fontSize.sm },
  alarmInfo: { padding: spacing.sm },
  alarmBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.dangerLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.xs,
    marginBottom: 3,
  },
  alarmBadgeText: { fontSize: fontSize.xs, color: colors.danger, fontWeight: '600' },
  alarmTime: { fontSize: fontSize.xs, color: colors.textMuted },

  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' },
  modalClose: { position: 'absolute', top: 50, right: 20, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  modalImage: { width: '92%', height: '70%' },
  modalFailed: { alignItems: 'center', gap: 10 },
  modalFailedText: { color: 'rgba(255,255,255,0.75)', fontSize: fontSize.sm },
});
