import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText } from '../../../src/components/AppText';
import { BackButton } from '../../../src/components/BackButton';
import { useHeaderTheme } from '../../../src/hooks/useHeaderTheme';
import { fontSize, headerThemes, radius, spacing } from '../../../src/theme';
import { useAppTheme } from '../../../src/ThemeProvider';
import { openExactAlarmSettings } from '../../../src/widgetData';

export default function MoreSystemSettings() {
  const router = useRouter();
  const { top } = useHeaderTheme(headerThemes.settings);
  const { colors: c } = useAppTheme();
  return <View style={[s.screen, { backgroundColor: c.background }]}>
    <Stack.Screen options={{ headerShown: false }} />
    <ScrollView contentContainerStyle={{ paddingTop: top, paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl }}>
      <View style={s.header}><BackButton /><View><AppText style={[s.title, { color: c.textPrimary }]}>系统设置</AppText><AppText style={[s.subtitle, { color: c.textMuted }]}>应用行为、更新与系统权限</AppText></View></View>
      <AppText style={[s.groupLabel, { color: c.textMuted }]}>应用行为</AppText>
      <View style={[s.group, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
        <SystemRow icon="grid-outline" title="桌面小组件" subtitle="刷新、显示与主题行为" onPress={() => router.push('/(tabs)/more/widget')} c={c} />
      </View>
      <AppText style={[s.groupLabel, { color: c.textMuted }]}>更新与版本</AppText>
      <View style={[s.group, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
        <SystemRow icon="cloud-download-outline" title="更新与高级工具" subtitle="检查版本、诊断与设备工具" onPress={() => router.push('/(tabs)/more/advanced-tools')} c={c} />
      </View>
      <AppText style={[s.groupLabel, { color: c.textMuted }]}>系统权限</AppText>
      <View style={[s.group, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
        <SystemRow icon="alarm-outline" title="闹钟与后台刷新权限" subtitle="允许小组件按设定频率刷新" onPress={() => void openExactAlarmSettings()} c={c} />
      </View>
    </ScrollView>
  </View>;
}

function SystemRow({ icon, title, subtitle, onPress, c }: { icon: keyof typeof Ionicons.glyphMap; title: string; subtitle: string; onPress: () => void; c: ReturnType<typeof useAppTheme>['colors'] }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.surfaceSecondary }]}>
    <View style={[s.icon, { backgroundColor: c.primarySoft }]}><Ionicons name={icon} size={19} color={c.primary} /></View>
    <View style={s.rowCopy}><AppText style={[s.rowTitle, { color: c.textPrimary }]}>{title}</AppText><AppText style={[s.rowSubtitle, { color: c.textMuted }]}>{subtitle}</AppText></View>
    <Ionicons name="chevron-forward" size={17} color={c.textDim} />
  </Pressable>;
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xxl },
  title: { fontSize: fontSize.xxl, fontWeight: '800' },
  subtitle: { fontSize: fontSize.xs, marginTop: 2 },
  groupLabel: { fontSize: fontSize.sm, fontWeight: '700', marginBottom: spacing.sm, marginLeft: spacing.xs },
  group: { borderWidth: 1, borderRadius: radius.xl, overflow: 'hidden', marginBottom: spacing.xl },
  row: { minHeight: 70, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: { width: 36, height: 36, borderRadius: radius.md, justifyContent: 'center', alignItems: 'center' },
  rowCopy: { flex: 1 },
  rowTitle: { fontSize: fontSize.md, fontWeight: '700' },
  rowSubtitle: { fontSize: fontSize.xs, marginTop: 3 },
});
