/**
 * Grid — responsive multi-column layout using the negative-margin gutter pattern.
 *
 * Why: the previous approach set each cell to `flexBasis: 100/cols%` and used
 * the container's `gap` for spacing — so N cells summed to 100% PLUS N-1 gaps
 * and overflowed, forcing an early wrap (e.g. 3 cards that should fill a row
 * broke onto a second line). Here the gutter lives in per-cell padding and the
 * container compensates with a negative margin, so cells always fit exactly.
 *
 * Children are laid out left-to-right, top-to-bottom; each cell gets
 * `flexBasis: 100/cols%`. Use `useResponsive().gridCols(minWidth)` for cols.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

export function Grid({
  cols,
  gap = 0,
  children,
}: {
  cols: number;
  /** Gutter between cells (dp). Split evenly as padding around each cell. */
  gap?: number;
  children?: React.ReactNode;
}) {
  const n = Math.max(1, Math.floor(cols));
  const basis = `${100 / n}%` as const;
  const half = gap / 2;
  const items = React.Children.toArray(children);
  return (
    <View style={[styles.row, { marginHorizontal: -half, marginVertical: -half }]}>
      {items.map((child, i) => (
        <View key={i} style={[styles.cell, { flexBasis: basis, padding: half }]}>
          {child}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { flexGrow: 0, flexShrink: 0 },
});
