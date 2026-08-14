import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fontSize, iconSize, radius, shadow } from '../../src/theme';
import { InfoHintProvider } from '../../src/components/InfoHint';
import { useAppTheme } from '../../src/ThemeProvider';

function TabIcon({ name, focused, active, muted }: { name: keyof typeof Ionicons.glyphMap; focused: boolean; active: string; muted: string }) {
  return (
    <View style={[styles.tabIconWrap, focused && styles.tabIconActive]}>
      <Ionicons name={name} size={iconSize.xl} color={focused ? active : muted} />
    </View>
  );
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useAppTheme();
  return (
    <InfoHintProvider>
    {/* 无顶部标题栏：内容自状态栏下开始（各页面用 useHeaderTheme 的 top 内边距），
       状态栏样式仍由各页 useHeaderTheme 按 tab 主题设置。 */}
    <Tabs screenOptions={{
      headerShown: false,
      tabBarStyle: [styles.tabBar, { backgroundColor: c.surface, borderTopColor: c.border, height: 64 + insets.bottom, paddingBottom: Math.max(insets.bottom, 6) }],
      sceneStyle: { backgroundColor: c.background },
      tabBarActiveTintColor: c.primary,
      tabBarInactiveTintColor: c.textMuted,
      tabBarLabelStyle: styles.tabLabel,
      tabBarHideOnKeyboard: true,
    }}>
      <Tabs.Screen name="index" options={{
        title: '总览',
        tabBarIcon: ({ focused }) => <TabIcon name="speedometer-outline" focused={focused} active={c.primary} muted={c.textMuted} />,
      }} />
      {/* 7 个 tab 后单格宽度约 55dp，4 字标签会被截断 → 用 2 字（页面内标题仍是"行程记录"） */}
      <Tabs.Screen name="rides" options={{
        title: '行程',
        tabBarIcon: ({ focused }) => <TabIcon name="bicycle-outline" focused={focused} active={c.primary} muted={c.textMuted} />,
      }} />
      <Tabs.Screen name="battery" options={{
        title: '电池',
        tabBarIcon: ({ focused }) => <TabIcon name="battery-half-outline" focused={focused} active={c.primary} muted={c.textMuted} />,
      }} />
      <Tabs.Screen name="dashboard" options={{
        title: '仪表板',
        tabBarIcon: ({ focused }) => <TabIcon name="hardware-chip-outline" focused={focused} active={c.primary} muted={c.textMuted} />,
      }} />
      <Tabs.Screen name="more" options={{
        title: '更多',
        tabBarIcon: ({ focused }) => <TabIcon name="grid-outline" focused={focused} active={c.primary} muted={c.textMuted} />,
      }} />
      <Tabs.Screen name="camera" options={{ href: null,
        title: '监控',
        tabBarIcon: ({ focused }) => <TabIcon name="videocam-outline" focused={focused} active={c.primary} muted={c.textMuted} />,
      }} />
      <Tabs.Screen name="relay" options={{ href: null,
        title: '远控',
        tabBarIcon: ({ focused }) => <TabIcon name="radio-outline" focused={focused} active={c.primary} muted={c.textMuted} />,
      }} />
      <Tabs.Screen name="settings" options={{ href: null,
        title: '设置',
        tabBarIcon: ({ focused }) => <TabIcon name="settings-outline" focused={focused} active={c.primary} muted={c.textMuted} />,
      }} />
    </Tabs>
    </InfoHintProvider>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.card,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: 7,
    height: 64,
    paddingHorizontal: 8,
    ...shadow.card,
  },
  tabLabel: { fontSize: fontSize.xs, fontWeight: '700', marginTop: 3 },
  tabIconWrap: {
    width: 42, height: 29, borderRadius: radius.full,
    justifyContent: 'center', alignItems: 'center',
  },
  tabIconActive: {
    backgroundColor: 'transparent',
  },
});
