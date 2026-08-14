import { Link, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import { AppText } from '../src/components/AppText';
import { colors, fontSize, radius, shadow, spacing } from '../src/theme';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: '页面不存在' }} />
      <View style={s.container}>
        <View style={s.card}>
          <View style={s.icon}><Ionicons name="compass-outline" size={32} color={colors.primary} /></View>
          <AppText style={s.code}>404</AppText>
          <AppText style={s.text}>这里没有车辆数据</AppText>
          <AppText style={s.sub}>页面可能已移动，返回总览继续使用。</AppText>
          <Link href="/" style={s.link}>返回车辆总览</Link>
        </View>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, backgroundColor: colors.bg },
  card: { width: '100%', maxWidth: 360, alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.xxl, borderWidth: 1, borderColor: colors.borderLight, padding: spacing.xxxl, ...shadow.card },
  icon: { width: 64, height: 64, borderRadius: radius.xl, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  code: { marginTop: spacing.xl, fontSize: 36, fontWeight: '800', color: colors.text },
  text: { marginTop: spacing.xs, fontSize: fontSize.lg, fontWeight: '700', color: colors.textSecondary },
  sub: { marginTop: spacing.sm, fontSize: fontSize.sm, lineHeight: 20, textAlign: 'center', color: colors.textMuted },
  link: { fontSize: fontSize.md, fontWeight: '700', color: colors.primary, marginTop: spacing.xl, paddingVertical: spacing.md, paddingHorizontal: spacing.xl, backgroundColor: colors.primaryLight, borderRadius: radius.full },
});
