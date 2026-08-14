import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText } from '../../../../src/components/AppText';
import { useAppTheme } from '../../../../src/ThemeProvider';
import { getWidgetRefreshInterval, setWidgetRefreshInterval } from '../../../../src/widgetData';
import { fontSize, radius, spacing } from '../../../../src/theme';
import { useEffect, useState } from 'react';

const OPTIONS = [1, 5, 10, 15, 30];

export default function WidgetRefreshRate() {
  const router = useRouter();
  const { colors: c } = useAppTheme();
  const [minutes, setMinutes] = useState(30);

  useEffect(() => { void getWidgetRefreshInterval().then(setMinutes); }, []);

  const choose = async (value: number) => {
    setMinutes(value);
    await setWidgetRefreshInterval(value);
  };

  return <View style={[s.screen, { backgroundColor: c.background }]}>
    <Stack.Screen options={{ headerShown: false }} />
    <ScrollView contentContainerStyle={s.content}>
      <View style={s.header}>
        <Pressable accessibilityLabel="返回" onPress={() => router.back()} hitSlop={10} style={[s.back, { backgroundColor: c.surfaceSecondary }]}>
          <Ionicons name="arrow-back" size={20} color={c.textPrimary} />
        </Pressable>
        <View><AppText style={[s.title, { color: c.textPrimary }]}>刷新频率</AppText><AppText style={[s.subtitle, { color: c.textMuted }]}>桌面小组件后台自动刷新</AppText></View>
      </View>
      <View style={[s.group, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
        {OPTIONS.map((value, index) => <Pressable key={value} onPress={() => void choose(value)} style={[s.row, index > 0 && { borderTopWidth: 1, borderTopColor: c.borderSubtle }]}>
          <View style={[s.icon, { backgroundColor: value === minutes ? c.primarySoft : c.surfaceSecondary }]}><Ionicons name="time-outline" size={18} color={value === minutes ? c.primary : c.textSecondary} /></View>
          <AppText style={[s.rowTitle, { color: c.textPrimary }]}>{value} 分钟</AppText>
          {value === minutes && <Ionicons name="checkmark-circle" size={20} color={c.primary} />}
        </Pressable>)}
      </View>
      <AppText style={[s.note, { color: c.textMuted }]}>刷新由 Android 后台调度，系统省电策略可能造成实际时间略有延迟。</AppText>
    </ScrollView>
  </View>;
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.lg, paddingTop: 48, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xxl },
  back: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: fontSize.xxl, fontWeight: '800' },
  subtitle: { fontSize: fontSize.xs, marginTop: 2 },
  group: { borderWidth: 1, borderRadius: radius.xl, overflow: 'hidden' },
  row: { minHeight: 64, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: { width: 34, height: 34, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { flex: 1, fontSize: fontSize.md, fontWeight: '600' },
  note: { fontSize: fontSize.xs, lineHeight: 18, marginTop: spacing.md, paddingHorizontal: spacing.xs },
});
