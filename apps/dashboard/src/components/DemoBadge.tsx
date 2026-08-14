import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from './AppText';
import { useAppTheme } from '../ThemeProvider';
import { useDemoMode } from '../demo/DemoModeProvider';

/** Small global marker so simulated telemetry is never mistaken for live data. */
export function DemoBadge() {
  const { isDemoMode } = useDemoMode();
  const { colors: c } = useAppTheme();
  const insets = useSafeAreaInsets();
  if (!isDemoMode) return null;
  return <View pointerEvents="none" style={[s.badge, { top: Math.max(insets.top, 8) + 3, backgroundColor: c.primarySoft, borderColor: c.primary }]}>
    <View style={[s.dot, { backgroundColor: c.primary }]} />
    <AppText style={[s.text, { color: c.primary }]}>DEMO</AppText>
  </View>;
}

const s = StyleSheet.create({
  badge: { position: 'absolute', right: 12, zIndex: 1000, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  text: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
});
