/**
 * SectionHeader — consistent small-section title row across screens.
 *
 * Replaces the several bespoke "sectionTitle" styles (font-xs bold gray in
 * battery, font-lg bold black in camera, inline icon+text in bms) with one
 * predictable component: optional icon halo, title, optional badge, optional
 * trailing accessory (e.g. point count, "展开/收起").
 */
import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { Ionicons } from '@expo/vector-icons';
import { badgeTones, colors, fontSize, radius, spacing, type BadgeTone } from '../theme';
import { useAppTheme } from '../ThemeProvider';

export function SectionHeader({
  icon,
  title,
  badge,
  badgeTone = 'gray',
  accessory,
  style,
  variant = 'plain',
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  badge?: string;
  badgeTone?: BadgeTone;
  accessory?: React.ReactNode;
  style?: ViewStyle;
  variant?: 'plain' | 'accent';
}) {
  const { colors: c } = useAppTheme();
  const tone = badgeTones[badgeTone];
  return (
    <View style={[styles.row, style]}>
      {icon && (
        <View style={[styles.iconHalo, { backgroundColor: variant === 'accent' ? c.primarySoft : 'transparent' }]}>
          <Ionicons name={icon} size={15} color={variant === 'accent' ? c.primary : c.textSecondary} />
        </View>
      )}
      <AppText style={[styles.title, { color: c.textPrimary }]}>{title}</AppText>
      {badge != null && (
        <View style={[styles.badge, { backgroundColor: tone.bg }]}>
          <AppText style={[styles.badgeText, { color: tone.fg }]} numberOfLines={1}>{badge}</AppText>
        </View>
      )}
      {accessory != null && <View style={styles.accessory}>{accessory}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  iconHalo: {
    width: 32, height: 32, borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
    justifyContent: 'center', alignItems: 'center',
  },
  title: { flex: 1, fontSize: fontSize.md, fontWeight: '700', color: colors.text, letterSpacing: 0.1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.xs, overflow: 'hidden' },
  badgeText: { fontSize: fontSize.xs, fontWeight: '600' },
  accessory: { marginLeft: 'auto' },
});
