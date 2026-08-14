/**
 * Shared design tokens — single source of truth for the app's visual language.
 *
 * 2026-07 redesign goals:
 *  - Preserve the established indigo-on-light palette (user pref: 精修不大改配色).
 *  - Add a display type scale + monospace numeric token for data-heavy screens.
 *  - Soften shadows and enlarge card radii for a more contemporary feel.
 *  - Unify per-tab headers to a consistent light treatment with a subtle accent
 *    (tinted icon halo + thin accent rule) — eliminates the old whiplash
 *    between flat-white and saturated-gradient headers when switching tabs.
 *  - Expose breakpoint metadata so useResponsive can drive adaptive grids.
 *
 * Backward compatibility: every token name consumed by the v1 screens is kept
 * (values may shift slightly); new tokens are additive.
 */

import type { StatusBarStyle } from 'expo-status-bar';
import { Platform } from 'react-native';

export const colors = {
  // Brand
  primary: '#7657F6',
  primaryLight: '#ECE8FF',
  primaryDark: '#6547E6',

  // Semantic
  success: '#10b981',
  successLight: '#ecfdf5',
  warning: '#f59e0b',
  warningLight: '#fffbeb',
  danger: '#ef4444',
  dangerLight: '#fef2f2',
  info: '#3b82f6',
  infoLight: '#eff6ff',

  // Neutrals (very gently warmed slate — stays in the light family)
  bg: '#F5F6F8',
  card: '#ffffff',
  cardAlt: '#F0F1F5',
  border: '#E4E5EA',
  borderLight: '#ECECF1',
  text: '#17151D',
  textSecondary: '#5E5A68',
  // 2026-08 UI pass: muted labels previously #8b95a6 (~3.1:1 on white) failed
  // WCAG AA for small text. #6b7280 (gray-500) lifts contrast to ~4.6:1 while
  // keeping the same gentle, low-key feel — a refinement, not a palette change.
  textMuted: '#777280',
  textDim: '#AAA5B1',

  // Accent palette (per-tab identity + semantic highlights)
  accentGreen: '#059669',
  accentBlue: '#2563eb',
  accentIndigo: '#3258a8',
  accentAmber: '#d97706',
  accentRose: '#e11d48',
  accentTeal: '#168C9E',
  accentViolet: '#7657F6',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 22,
  xxl: 28,
  full: 999,
} as const;

export const fontSize = {
  // 2026-08 readability pass: 10px 在 360dp 窄屏 + muted 色下逼近可读下限，提到 11。
  xs: 11,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  xxl: 24,
  // Display scale — hero numbers on dashboard / battery / ride-detail.
  displaySm: 28,
  displayMd: 34,
  displayLg: 40,
  displayXl: 48,
} as const;

/** Unified font-weight scale — prefer these named tokens over raw '600' so the
 *  hierarchy stays consistent across screens (regular→heavy). */
export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  heavy: '800',
} as const;

/** Standard ion icon sizes — keeps glyphs visually consistent everywhere
 *  (metric tiles, section headers, tab bar, pills). */
export const iconSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  xxl: 22,
} as const;

/** Monospace family for numeric readouts (voltage / current / SN / coords).
 *  RN's fontFamily takes ONE font name — a CSS-style comma stack silently
 *  falls back to the default font, so every "mono" number was rendering
 *  proportional. Pick the platform's real mono face instead. */
export const fontMono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export const shadow = {
  /** Primary card elevation — softer + wider for the new larger radii. */
  card: {
    shadowColor: '#17313a',
    shadowOpacity: 0.045,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  /** Whisper-soft separation for chips / nested tiles. */
  subtle: {
    shadowColor: '#17313a',
    shadowOpacity: 0.035,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  /** Deeper drop used by elevated gradient cards / hero panels. */
  raised: {
    shadowColor: '#081b24',
    shadowOpacity: 0.14,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  /** Soft top-down inner gloom simulated by stacked Views under buttons. */
  pressed: {
    shadowColor: '#000',
    shadowOpacity: 0.10,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
} as const;

/** Responsive breakpoint thresholds (dp). Consumed by useResponsive. */
export const breakpoints = {
  compact: 360,  // small phones — single column, tighter padding
  regular: 412,  // typical phone width
  wide: 600,     // large phone / small tablet — allow 2-col grids to breathe
  tablet: 840,   // tablet — multi-column layouts
} as const;

export type Breakpoint = keyof typeof breakpoints;

/**
 * Per-tab visual identity. v2: every tab now uses a LIGHT header background
 * (from→to both light) so switching tabs feels consistent; `accent` is the
 * per-tab identity color used for the icon halo and the thin top accent rule.
 * Battery/BMS/Camera keep their saturated accent for identity, but the header
 * surface itself stays light.
 */
export interface HeaderTheme {
  /** Top→bottom gradient endpoints for the header background (light). */
  from: string;
  to: string;
  /** Foreground for the title text and icon. */
  foreground: string;
  /** Status-bar text style — `light` reads white, `dark` reads black. */
  statusBar: StatusBarStyle;
  /** Per-tab identity color (icon halo + accent rule). */
  accent: string;
  /** Soft tint behind the icon halo. */
  accentBg: string;
  /** Left icon shown next to the title. */
  icon: 'speedometer-outline' | 'battery-half-outline' | 'hardware-chip-outline' | 'videocam-outline' | 'bicycle-outline' | 'settings-outline' | 'radio-outline' | 'disc-outline';
  /** Page title (already shown by tab label, repeated in the header for clarity). */
  title: string;
}

export const headerThemes: Record<string, HeaderTheme> = {
  index:   { from: '#ffffff', to: colors.cardAlt, foreground: colors.text, statusBar: 'dark',  accent: colors.primary,      accentBg: colors.primaryLight, icon: 'speedometer-outline', title: '首页' },
  rides:   { from: '#ffffff', to: '#f3f0ff',      foreground: colors.text, statusBar: 'dark',  accent: colors.accentViolet, accentBg: '#f3f0ff',            icon: 'bicycle-outline',     title: '行程记录' },
  battery: { from: '#ffffff', to: colors.cardAlt, foreground: colors.text, statusBar: 'dark',  accent: colors.accentGreen,  accentBg: colors.successLight, icon: 'battery-half-outline', title: '电池分析' },
  dashboard:{ from: '#ffffff', to: colors.cardAlt, foreground: colors.text, statusBar: 'dark',  accent: colors.accentIndigo, accentBg: '#eef2ff',            icon: 'hardware-chip-outline', title: '仪表板' },
  camera:  { from: '#ffffff', to: colors.cardAlt, foreground: colors.text, statusBar: 'dark',  accent: colors.accentBlue,   accentBg: colors.infoLight,    icon: 'videocam-outline',     title: '萤石云监控' },
  relay:   { from: '#ffffff', to: colors.cardAlt, foreground: colors.text, statusBar: 'dark',  accent: colors.accentTeal,   accentBg: '#ecfeff',            icon: 'radio-outline',        title: '中继远控' },
  settings:{ from: '#ffffff', to: colors.cardAlt, foreground: colors.text, statusBar: 'dark',  accent: colors.primary,      accentBg: colors.primaryLight, icon: 'settings-outline',     title: '设置' },
};

/** Tiny palette for the per-status pill chips (lock/acc/charge/odometer). */
export const pillColors = {
  lock:    { fg: colors.accentGreen, bg: colors.successLight, icon: 'lock-closed'   },
  unlock:  { fg: colors.textMuted,   bg: colors.cardAlt,      icon: 'lock-open'     },
  accOn:   { fg: colors.primary,    bg: colors.primaryLight, icon: 'key'           },
  accOff:  { fg: colors.textMuted,   bg: colors.cardAlt,      icon: 'key-outline'   },
  charging:{ fg: colors.accentAmber, bg: colors.warningLight, icon: 'flash'         },
  idle:    { fg: colors.textMuted,   bg: colors.cardAlt,      icon: 'flash-off'     },
  range:   { fg: colors.accentBlue,  bg: colors.infoLight,   icon: 'navigate'      },
  none:    { fg: colors.textMuted,   bg: colors.cardAlt,      icon: 'ellipse-outline' },
} as const;

/** Semantic tone bundles for badges / status chips across screens. */
export type BadgeTone = 'gray' | 'emerald' | 'amber' | 'indigo' | 'rose' | 'blue';

export const badgeTones: Record<BadgeTone, { fg: string; bg: string }> = {
  gray:    { fg: colors.textSecondary, bg: colors.cardAlt },
  emerald: { fg: '#065f46', bg: '#d1fae5' },
  amber:   { fg: '#92400e', bg: colors.warningLight },
  indigo:  { fg: colors.primaryDark, bg: colors.primaryLight },
  rose:    { fg: '#9f1239', bg: '#ffe4e6' },
  blue:    { fg: '#1e40af', bg: colors.infoLight },
};

/**
 * Semantic "tint" tokens — the soft borders / pale fills that pair with the
 * danger·success·warning lights. These were previously hardcoded in several
 * screens (找茬报告 D-1), which let the palette drift. Centralised here so a
 * future tweak lands in one place. Hex values are preserved exactly — this is
 * a single-source-of-truth refactor, NOT a colour change.
 */
export const tint = {
  dangerBorder:  '#fecaca', // error-card border (dangerLight bg)
  successBorder: '#a7f3d0', // green card / badge border (successLight bg)
  successSoft:   '#d1fae5', // pale emerald fill (saved banner, icon box, ≥20% cam battery)
  warningBorder: '#fde68a', // amber card / badge border (warningLight bg)
  onSuccess:     '#047857', // green-700 text on pale green
  onEmerald:     '#065f46', // emerald-800 text on pale emerald
  onWarning:     '#92400e', // amber-800 text on pale amber
  onDanger:      '#b91c1c', // red-700 text on dangerLight
} as const;
