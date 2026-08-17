import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { AppText } from '../../../src/components/AppText';
import { useHeaderTheme } from '../../../src/hooks/useHeaderTheme';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { fontSize, headerThemes, radius, shadow, spacing } from '../../../src/theme';
import { useAppTheme } from '../../../src/ThemeProvider';
import { useDemoMode } from '../../../src/demo/DemoModeProvider';

type Tile = {
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  route?:
    | '/(tabs)/more/monitor'
    | '/(tabs)/more/relay'
    | '/(tabs)/more/theme-center'
    | '/(tabs)/more/widget'
    | '/(tabs)/more/notification-settings'
    | '/(tabs)/more/vehicle-settings'
    | '/(tabs)/more/data-settings'
    | '/(tabs)/more/battery-profile'
    | '/(tabs)/more/connection-account'
    | '/(tabs)/more/advanced-tools'
    | '/(tabs)/more/about';
  demo?: boolean;
};

const TILES: Tile[] = [
  { title: '监控', subtitle: '摄像头状态与告警', icon: 'videocam-outline', route: '/(tabs)/more/monitor' },
  { title: '中继与远控', subtitle: 'S7 状态、配置与远控', icon: 'radio-outline', route: '/(tabs)/more/relay' },
  { title: '主题中心', subtitle: '显示模式与 Theme Pack', icon: 'color-palette-outline', route: '/(tabs)/more/theme-center' },
  { title: '桌面小组件', subtitle: '刷新与显示设置', icon: 'grid-outline', route: '/(tabs)/more/widget' },
  { title: '通知设置', subtitle: '告警与提醒偏好', icon: 'notifications-outline', route: '/(tabs)/more/notification-settings' },
  { title: '车辆设置', subtitle: '车辆资料与锁定', icon: 'bicycle-outline', route: '/(tabs)/more/vehicle-settings' },
  { title: '数据设置', subtitle: '首页、阈值与采样', icon: 'analytics-outline', route: '/(tabs)/more/data-settings' },
  { title: '电池硬件档案', subtitle: '保护板规格与校准', icon: 'battery-charging-outline', route: '/(tabs)/more/battery-profile' },
  { title: '连接与账号', subtitle: '九号账号与服务器', icon: 'person-circle-outline', route: '/(tabs)/more/connection-account' },
  { title: '高级工具', subtitle: '更新、诊断与设备工具', icon: 'construct-outline', route: '/(tabs)/more/advanced-tools' },
  { title: '关于', subtitle: '版本与应用信息', icon: 'information-circle-outline', route: '/(tabs)/more/about' },
  { title: '演示模式', subtitle: '使用模拟车辆与设备数据', icon: 'flask-outline', demo: true },
];

export default function MoreHome() {
  const router = useRouter();
  const { top } = useHeaderTheme(headerThemes.settings);
  const rs = useResponsive();
  const { colors: c } = useAppTheme();
  const { isDemoMode, setDemoMode } = useDemoMode();
  const toggleDemo = () => {
    if (isDemoMode) { void setDemoMode(false); return; }
    Alert.alert('开启演示模式', '开启演示模式后，应用将显示模拟车辆与设备数据，不再展示实时车辆状态。', [
      { text: '取消', style: 'cancel' },
      { text: '开启演示模式', onPress: () => { void setDemoMode(true); } },
    ]);
  };
  return (
    <ScrollView style={[s.container, { backgroundColor: c.background }]} contentContainerStyle={{ paddingTop: top, paddingHorizontal: rs.pagePad, paddingBottom: spacing.xxxl }}>
      <AppText style={[s.title, { color: c.textPrimary }]}>功能中心</AppText>
      <AppText style={[s.subtitle, { color: c.textMuted }]}>车辆、设备与应用配置入口</AppText>
      <View style={s.grid}>
        {TILES.map(tile => (
          <Pressable key={tile.title} onPress={() => { if (!tile.demo && tile.route) router.push(tile.route); }} style={({ pressed }) => [s.tile, { backgroundColor: c.surface, borderColor: tile.demo && isDemoMode ? c.primary : c.borderSubtle }, pressed && { backgroundColor: c.surfaceSecondary, transform: [{ scale: 0.985 }] }]}>
            <View style={[s.iconBox, { backgroundColor: c.primarySoft }]}><Ionicons name={tile.icon} size={21} color={c.primary} /></View>
            <AppText style={[s.tileTitle, { color: c.textPrimary }]} numberOfLines={1}>{tile.title}</AppText>
            <AppText style={[s.tileSubtitle, { color: c.textMuted }]} numberOfLines={1}>{tile.subtitle}</AppText>
            {tile.demo ? <Switch value={isDemoMode} onValueChange={toggleDemo} trackColor={{ false: c.border, true: c.primarySoft }} thumbColor={isDemoMode ? c.primary : c.textDim} style={s.switch} /> : <Ionicons name="chevron-forward" size={15} color={c.textDim} style={s.chevron} />}
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  title: { fontSize: fontSize.xxl, fontWeight: '800' },
  subtitle: { fontSize: fontSize.sm, marginTop: 3, marginBottom: spacing.xl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: { width: '48%', minHeight: 142, borderRadius: radius.xl, borderWidth: 1, padding: spacing.md, ...shadow.subtle },
  iconBox: { width: 38, height: 38, borderRadius: radius.md, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  tileTitle: { fontSize: fontSize.md, fontWeight: '700' },
  tileSubtitle: { fontSize: fontSize.xs, marginTop: 5, paddingRight: 14 },
  chevron: { position: 'absolute', right: spacing.md, bottom: spacing.md },
  switch: { position: 'absolute', right: spacing.sm, bottom: spacing.sm, transform: [{ scale: 0.82 }] },
});
