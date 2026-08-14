/**
 * Pill chip shared by the home & battery "status row" — icon + light-tinted
 * capsule. Same component renders both the `已锁定`/`充电中` string and the
 * `65km` odometer so the visual language stays identical across pages.
 *
 * 2026-07 refine: tighter vertical padding, 1px hairline ring tinted to the
 * foreground color at low alpha (subtle "enclosed" feel without a hard border),
 * and a slightly larger icon for legibility.
 */
import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, pillColors, radius, shadow } from '../theme';
import { useAppTheme } from '../ThemeProvider';

export type StatusKey = keyof typeof pillColors;

export function StatusPill({ kind, label, icon, fg, bg, style }: {
  kind?: StatusKey;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  fg?: string;
  bg?: string;
  style?: ViewStyle;
}) {
  const { colors: c } = useAppTheme();
  const spec = kind ? pillColors[kind] : null;
  const color = fg ?? spec?.fg ?? c.textMuted;
  const bgCol = bg ?? spec?.bg ?? c.surfaceSecondary;
  const iconN = icon ?? spec?.icon ?? 'ellipse-outline';
  return (
    <View style={[styles.pill, { backgroundColor: bgCol, borderColor: bgCol }, style]}>
      <Ionicons name={iconN} size={13} color={color} />
      <AppText style={[styles.label, { color }]} numberOfLines={1}>{label}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 11, paddingVertical: 6,
    borderRadius: radius.full, borderWidth: 1,
  },
  label: { fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 0.2 },
});
