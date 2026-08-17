import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';
import { colors, radius, spacing } from '../theme';

export function BackButton({ onPress }: { onPress?: () => void } = {}) {
  const router = useRouter();
  return (
    <Pressable accessibilityLabel="返回" hitSlop={10} onPress={onPress ?? (() => router.back())}
      style={({ pressed }) => [s.button, pressed && s.pressed]}>
      <Ionicons name="arrow-back" size={20} color={colors.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: { width: 40, height: 40, marginBottom: spacing.md, borderRadius: radius.full, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
