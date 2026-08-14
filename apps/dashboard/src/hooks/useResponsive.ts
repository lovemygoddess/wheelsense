/**
 * useResponsive — adaptive layout hook.
 *
 * Drives:
 *  - page horizontal padding (tighter on compact phones, roomier on tablets)
 *  - grid column count for metric tiles / alarm gallery / data grids
 *  - a uniform scale factor so hero numbers / icon halos breathe on tablets
 *
 * Re-renders on dimension change (rotation, fold, multi-window) via the
 * useWindowDimensions subscription.
 */
import { useWindowDimensions } from 'react-native';
import { breakpoints, spacing } from '../theme';

export type SizeClass = 'compact' | 'regular' | 'wide' | 'tablet';

export interface Responsive {
  width: number;
  height: number;
  sizeClass: SizeClass;
  /** Page horizontal padding (dp). */
  pagePad: number;
  /** Gap between grid cells (dp). */
  gridGap: number;
  /** How many columns a 2-or-more-up grid should use at this width. */
  gridCols: (minItemWidth?: number) => number;
  /** Hero number font-size scale multiplier (1 on phone, ~1.08 on wide). */
  heroScale: number;
  /** Whether the device is in landscape (width > height). */
  landscape: boolean;
}

export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const sizeClass: SizeClass =
    width >= breakpoints.tablet ? 'tablet'
    : width >= breakpoints.wide ? 'wide'
    : width >= breakpoints.regular ? 'regular'
    : 'compact';

  const pagePad =
    sizeClass === 'compact' ? spacing.md   // 12
    : sizeClass === 'tablet' ? spacing.xxxl // 32
    : spacing.lg;                            // 16

  const gridGap =
    sizeClass === 'compact' ? spacing.sm
    : sizeClass === 'tablet' ? spacing.lg
    : spacing.md;

  const heroScale =
    sizeClass === 'compact' ? 0.92
    : sizeClass === 'wide' || sizeClass === 'tablet' ? 1.08
    : 1;

  const gridCols = (minItemWidth = 150) => {
    // available = width - 2*pagePad; columns = floor(available / (min+gap))
    const available = width - pagePad * 2;
    return Math.max(1, Math.floor((available + gridGap) / (minItemWidth + gridGap)));
  };

  return {
    width,
    height,
    sizeClass,
    pagePad,
    gridGap,
    gridCols,
    heroScale,
    landscape: width > height,
  };
}
