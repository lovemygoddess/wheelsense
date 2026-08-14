import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, Animated, Easing } from 'react-native';
import { colors } from '../theme';
import { useAppTheme } from '../ThemeProvider';

function hexToRgb(h: string): [number, number, number] {
  const x = h.replace('#', '');
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

/**
 * Charge-state colour ramp: full → empty.
 *   100% 绿 → 嫩绿 → 黄绿 → 黄(<35% 起) → 琥珀(<20% 起) → 0% 深红
 * 旧版满电为紫、50% 已落入琥珀，"还剩一半电"被误读成低电警告；
 * 现高段保持绿/青，警示色收敛到低电量区。null → neutral grey.
 */
const SOC_RAMP = ['#10b981', '#4ade80', '#a3e635', '#facc15', '#f59e0b', '#dc2626'];
export function socRampColor(pct: number | null): string {
  if (pct == null) return '#9ca3af';
  const p = Math.max(0, Math.min(100, pct));
  const t = (1 - p / 100) * (SOC_RAMP.length - 1);
  const i = Math.min(SOC_RAMP.length - 1, Math.floor(t));
  const f = t - i;
  return mix(SOC_RAMP[i], SOC_RAMP[Math.min(SOC_RAMP.length - 1, i + 1)], f);
}
/** Readable text colour derived from the SOC ramp (darkened for contrast on light bg). */
export function socRampText(pct: number | null): string {
  return mix(socRampColor(pct), '#111827', 0.42);
}

/**
 * Smooth, animated circular progress gauge — pure RN views, no SVG dependency.
 *
 * - Ticks are thin and overlap into a continuous arc (no chunky segments).
 * - The arc *sweeps* from 0 to the target value on mount and whenever the
 *   value changes (the "动效" you asked for), via an Animated.Value + listener
 *   that only re-renders when the filled-tick count changes.
 * - A subtle 2-tone gradient runs along the arc (darker at the start, lighter
 *   toward the tip) for a glossy, premium feel.
 * - The centre is left for the caller's children (the value), with no label.
 */
export function ProgressRing({
  size = 96,
  strokeWidth = 8,
  progress,
  color,
  colorEnd,
  trackColor,
  segments = 100,
  glow = false,
  children,
  duration = 950,
  useSocColor = false,
}: {
  size?: number;
  strokeWidth?: number;
  progress: number | null; // 0..1, null = unknown
  color: string;
  /** Optional end colour of the along-arc gradient. Defaults to a lightened `color`. */
  colorEnd?: string;
  trackColor?: string;
  segments?: number;
  /** Soft breathing halo behind the ring. */
  glow?: boolean;
  children?: React.ReactNode;
  duration?: number;
  /** Drive the arc colour from the charge-state ramp (full→empty) instead of a fixed `color`. */
  useSocColor?: boolean;
}) {
  const { colors: c } = useAppTheme();
  const resolvedTrackColor = trackColor ?? c.borderSubtle;
  const clamped = progress == null ? null : Math.max(0, Math.min(1, progress));
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const slot = (2 * Math.PI * r) / segments;
  const segW = Math.min(strokeWidth * 1.05, slot * 0.92);
  const baseColor = useSocColor && clamped != null ? socRampColor(clamped * 100) : color;
  const endColor = useSocColor && clamped != null ? mix(baseColor, '#ffffff', 0.3) : (colorEnd ?? mix(color, '#ffffff', 0.32));

  // Animated fill: sweeps 0 -> target on mount and on every value change.
  const fillAnim = useRef(new Animated.Value(0)).current;
  const [filled, setFilled] = useState(0);

  useEffect(() => {
    const to = clamped == null ? 0 : clamped;
    const t = Animated.timing(fillAnim, {
      toValue: to,
      duration: clamped == null ? 0 : duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    t.start();
    const id = fillAnim.addListener(({ value }) => {
      const f = Math.round(value * segments);
      setFilled((prev) => (prev === f ? prev : f));
    });
    return () => {
      t.stop();
      fillAnim.removeListener(id);
    };
  }, [clamped, segments, duration, fillAnim]);

  const colorAt = (i: number) => mix(baseColor, endColor, i / (segments - 1));

  // 几何只依赖尺寸，与填充/颜色无关 —— 缓存后每次重渲染不再重建 100 个 View。
  const geo = useMemo(() => {
    const arr: { left: number; top: number; width: number; height: number; rotate: string }[] = [];
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * 360 - 90;
      const rad = (angle * Math.PI) / 180;
      arr.push({
        left: cx + r * Math.cos(rad) - segW / 2,
        top: cy + r * Math.sin(rad) - strokeWidth / 2,
        width: segW,
        height: strokeWidth,
        rotate: `${angle + 90}deg`,
      });
    }
    return arr;
  }, [segments, cx, cy, r, segW, strokeWidth]);

  // 颜色渐变同样只随基础色变化，缓存避免每帧重复 mix() 计算。
  const palette = useMemo(
    () => Array.from({ length: segments }, (_, i) => colorAt(i)),
    [segments, baseColor, endColor],
  );

  const ticks: React.ReactNode[] = geo.map((g, i) => (
    <View
      key={i}
      style={{
        position: 'absolute',
        left: g.left,
        top: g.top,
        width: g.width,
        height: g.height,
        borderRadius: segW / 2,
        backgroundColor: i < filled ? palette[i] : resolvedTrackColor,
        transform: [{ rotate: g.rotate }],
      }}
    />
  ));

  // Rounded leading cap — a soft dot at the tip of the filled arc.
  let cap: React.ReactNode = null;
  if (filled > 0 && filled < segments) {
    const a = (filled / segments) * 360 - 90;
    const rad = (a * Math.PI) / 180;
    const capX = cx + r * Math.cos(rad);
    const capY = cy + r * Math.sin(rad);
    cap = (
      <View
        key="cap"
        style={{
          position: 'absolute',
          left: capX - strokeWidth / 2,
          top: capY - strokeWidth / 2,
          width: strokeWidth,
          height: strokeWidth,
          borderRadius: strokeWidth / 2,
          backgroundColor: endColor,
        }}
      />
    );
  }

  // Soft halo: a faint filled disk gently breathing behind the gauge (no hard
  // second ring — that was the old "double-ring" cheap look).
  const haloOpacity = useRef(new Animated.Value(0.1)).current;
  useEffect(() => {
    if (!glow) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(haloOpacity, { toValue: 0.22, duration: 1700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(haloOpacity, { toValue: 0.1, duration: 1700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [glow]);

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {glow && filled > 0 && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: size * 1.24,
            height: size * 1.24,
            borderRadius: (size * 1.24) / 2,
            backgroundColor: baseColor,
            opacity: haloOpacity,
          }}
        />
      )}
      {ticks}
      {cap}
      <View style={{ alignItems: 'center' }}>{children}</View>
    </View>
  );
}
