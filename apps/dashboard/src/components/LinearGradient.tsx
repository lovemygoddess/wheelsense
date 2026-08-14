/**
 * Tiny pure-RN linear gradient — no expo-linear-gradient native rebuild needed.
 *
 * The strip layer is absolutely positioned so it fills the entire parent box
 * (including any padding the caller passes via `style`), while the children
 * remain direct siblings in the normal flex flow — so they inherit the
 * caller's padding, gap, flexDirection, etc. exactly as a plain <View> would.
 *
 * Good enough for "slight depth on cards/buttons" without going flat.
 */
import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

function parseColor(s: string): [number, number, number] {
  const h = s.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function LinearGradient({
  from,
  to,
  steps = 6,
  style,
  children,
  diagonal = false,
}: {
  from: string;
  to: string;
  steps?: number;
  style?: ViewStyle;
  children?: React.ReactNode;
  /** When true, the strips are skewed — handy for hero/photo backgrounds. */
  diagonal?: boolean;
}) {
  const a = parseColor(from);
  const b = parseColor(to);
  const strips: React.ReactNode[] = [];
  const n = Math.max(2, steps);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    strips.push(
      <View key={i} style={[styles.strip, {
        backgroundColor: `rgb(${r}, ${g}, ${bl})`,
        // Overlap each strip into the next by 1px: without this, fractional
        // strip heights (box height not divisible by step count) round apart
        // and hairline slivers of the container background show through —
        // the "white thin lines" on the relay photo hero.
        ...(i < n - 1 ? { marginBottom: -1 } : null),
        ...(diagonal ? { transform: [{ skewY: `${(t - 0.5) * 6}deg` }] } : null),
      }]} />
    );
  }
  return (
    // The container itself paints the `from` colour, so even if every strip
    // somehow shrinks, the fallback behind them is gradient-adjacent, never
    // the card/screen background.
    <View style={[style, { overflow: 'hidden', backgroundColor: from }]}>
      {/* Strips painted first → children (next sibling) render on top. */}
      <View style={styles.stack} pointerEvents="none">{strips}</View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'column' },
  strip: { flex: 1 },
});