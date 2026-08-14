/**
 * Empty / loading placeholder with a gently animated icon.
 *
 * 2026-07 refine: larger halo (96), softer multi-layer shadow, refined
 * button (radius.lg, accent-tinted). Same three animation variants.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppText } from './AppText';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, radius, shadow, spacing } from '../theme';

export function EmptyState({
  icon,
  title,
  subtitle,
  actionLabel,
  onAction,
  accent = colors.primary,
  accentBg = colors.primaryLight,
  variant = 'pulse',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  accent?: string;
  accentBg?: string;
  /** Determines which breathing animation plays:
   *  pulse  — scale in/out around the icon (good for "loading")
   *  orbit  — slow rotation, for "searching"
   *  float  — vertical bob, for static "nothing here" states */
  variant?: 'pulse' | 'orbit' | 'float';
}) {
  const value = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let seq: Animated.CompositeAnimation;
    if (variant === 'pulse') {
      seq = Animated.loop(Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 1100, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(value, { toValue: 0, duration: 1100, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ]));
    } else if (variant === 'orbit') {
      seq = Animated.loop(Animated.timing(value, { toValue: 1, duration: 3200, useNativeDriver: true, easing: Easing.linear }));
    } else {
      seq = Animated.loop(Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 1300, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(value, { toValue: 0, duration: 1300, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ]));
    }
    seq.start();
    return () => { seq.stop(); seq.reset(); };
  }, [value, variant]);

  const animStyle =
    variant === 'pulse' ? { transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.08] }) }] } :
    variant === 'orbit' ? { transform: [{ rotate: value.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] } :
    { transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }] };

  return (
    <View style={styles.wrap}>
      <View style={[styles.iconHalo, { backgroundColor: accentBg }]}>
        <Animated.View style={animStyle}>
          <Ionicons name={icon} size={38} color={accent} />
        </Animated.View>
      </View>
      <AppText style={styles.title}>{title}</AppText>
      {subtitle && <AppText style={styles.subtitle}>{subtitle}</AppText>}
      {actionLabel && onAction && (
        <Pressable style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]} onPress={onAction}>
          <AppText style={styles.btnText}>{actionLabel}</AppText>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 300, justifyContent: 'center', alignItems: 'center', paddingVertical: 56, paddingHorizontal: 32, gap: spacing.md },
  iconHalo: { width: 96, height: 96, borderRadius: 48, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xs, ...shadow.card },
  title: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 18 },
  btn: { marginTop: spacing.xs, paddingVertical: 11, paddingHorizontal: 24, borderRadius: radius.lg, backgroundColor: colors.primary },
  btnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
});
