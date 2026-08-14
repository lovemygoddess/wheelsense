/**
 * Card — unified surface container.
 *
 * Replaces the ad-hoc `{ marginHorizontal: spacing.lg, marginBottom: 10,
 * backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg,
 * ...shadow.card }` pattern repeated in every screen's StyleSheet. One source
 * of truth → consistent radius / shadow / rhythm across the app.
 */
import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { colors, radius, shadow, spacing } from '../theme';
import { useAppTheme } from '../ThemeProvider';

export type CardVariant = 'default' | 'flat' | 'raised' | 'inset';

export function Card({
  children,
  variant = 'default',
  pad = true,
  style,
}: {
  children?: React.ReactNode;
  variant?: CardVariant;
  pad?: boolean;
  style?: ViewStyle | ViewStyle[];
}) {
  const { colors: c, theme } = useAppTheme();
  const v =
    variant === 'flat' ? styles.flat
    : variant === 'raised' ? styles.raised
    : variant === 'inset' ? styles.inset
    : styles.default;
  const surface = variant === 'inset' ? c.surfaceSecondary : c.surface;
  return <View style={[v, { backgroundColor: surface, borderColor: c.borderSubtle, borderRadius: theme.pack.radiusStyle === 'rounded' ? radius.xxl : undefined }, pad && styles.padded, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  default: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderLight,
    ...shadow.subtle,
  } as ViewStyle,
  flat: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
  } as ViewStyle,
  raised: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderLight,
    ...shadow.raised,
  } as ViewStyle,
  inset: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.lg,
  } as ViewStyle,
  padded: {
    padding: spacing.lg,
  },
});
