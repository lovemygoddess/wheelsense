/**
 * Skeleton — shimmering placeholder primitives.
 *
 * Compose these to mirror a screen's real layout so it "settles into place"
 * instead of flashing a spinner. One shimmer loop per screen (via
 * `useShimmer`) keeps the animation count low — every `Skeleton` block reads
 * the same shared opacity value.
 *
 * The shimmer is a gentle opacity breath (0.4 → 1) rather than a sliding
 * gradient sweep — cleaner, cheaper, and reads as "premium loading" on iOS.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, type ViewStyle } from 'react-native';
import { colors, radius } from '../theme';

/** Start a shared shimmer loop and return its value. Call once per skeleton screen. */
export function useShimmer(): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const seq = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 1100, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(v, { toValue: 0, duration: 1100, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ]),
    );
    seq.start();
    return () => seq.stop();
  }, [v]);
  return v;
}

export function Skeleton({
  value,
  width,
  height = 12,
  round,
  style,
}: {
  value: Animated.Value;
  width?: number | string;
  height?: number;
  round?: number;
  style?: ViewStyle;
}) {
  const opacity = value.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  return (
    <Animated.View
      style={[
        {
          backgroundColor: colors.cardAlt,
          borderRadius: round ?? radius.md,
          width: (width ?? '100%') as number | `${number}%`,
          height,
        },
        { opacity },
        style,
      ]}
    />
  );
}
