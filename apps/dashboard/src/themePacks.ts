import type { ImageSourcePropType } from 'react-native';
import { fontSize, fontWeight, radius, spacing } from './theme';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedThemeMode = 'light' | 'dark';
export type ThemePackId = 'default-tech' | 'anime-01';
export type WidgetThemeBehavior = 'app' | 'system' | 'independent';
export type ThemeAsset = ImageSourcePropType | null;

export interface ThemeColors {
  primary: string; primaryPressed: string; primarySoft: string;
  background: string; surface: string; surfaceSecondary: string;
  border: string; borderSubtle: string;
  textPrimary: string; textSecondary: string; textMuted: string; textDim: string;
  success: string; successSoft: string; warning: string; warningSoft: string;
  danger: string; dangerSoft: string; info: string; infoSoft: string;
  onPrimary: string;
}

export interface ThemePackLayout {
  characterPosition: 'left' | 'right' | 'edge';
  characterAnchor: 'top' | 'center' | 'bottom';
  characterScale: number; characterOffsetX: number; characterOffsetY: number;
  characterZIndex: number; vehicleScale: number; vehicleOffsetX: number; vehicleOffsetY: number;
}

/** Optional artwork. Every consumer must render correctly when every slot is null. */
export interface ThemeAssetMap {
  characterHero?: ThemeAsset; characterHeroDark?: ThemeAsset; heroDecoration?: ThemeAsset; heroBackground?: ThemeAsset;
  themeLogo?: ThemeAsset; themeBadge?: ThemeAsset; tripDecoration?: ThemeAsset; tripCharacter?: ThemeAsset;
  dashboardDecoration?: ThemeAsset; dashboardAvatar?: ThemeAsset; hudDecoration?: ThemeAsset;
  loginBackground?: ThemeAsset; loginDecoration?: ThemeAsset;
  widgetCharacter?: ThemeAsset; widgetDecoration?: ThemeAsset; widgetBackground?: ThemeAsset;
  pageBackground?: ThemeAsset; sectionDecoration?: ThemeAsset; cornerDecoration?: ThemeAsset; texture?: ThemeAsset;
}

export interface ThemePackManifest {
  schemaVersion: 1; id: string; name: string; version: string; author: string;
  minAppVersion: string; description: string; available: boolean;
  preview?: ThemeAsset;
  colors: Partial<Record<ResolvedThemeMode, Partial<ThemeColors>>>;
  assets?: ThemeAssetMap;
  typography?: { titleFontKey?: string; sectionFontKey?: string; decorativeFontKey?: string };
  layout?: Partial<ThemePackLayout>;
  dashboard?: { hudStyle?: 'arc' | 'line'; decorationOpacity?: number; avatarSize?: number; avatarCrop?: 'full' | 'upper' };
  widget?: { style?: 'tech' | 'character'; glowOpacity?: number; characterMaxFraction?: number; nativeCharacterAsset?: string; characterCropTop?: number; characterCropBottom?: number };
  dialogue?: { home?: string[]; trip?: string[]; charging?: string[]; warning?: string[]; enabledByDefault?: boolean };
}

export interface ThemePack extends Omit<ThemePackManifest, 'colors' | 'layout' | 'dashboard' | 'widget' | 'typography'> {
  id: ThemePackId; colors: Record<ResolvedThemeMode, ThemeColors>;
  typography: { titleFontKey?: string; sectionFontKey?: string; decorativeFontKey?: string };
  surfaces: { cardOpacity: number; heroGlowOpacity: number };
  borderStyle: 'hairline' | 'decorative'; radiusStyle: 'soft' | 'rounded'; shadowStyle: 'minimal' | 'soft';
  pageBackground: 'solid' | 'ambient'; decorations: { enabled: boolean };
  hero: ThemePackLayout; dashboard: { hudStyle: 'arc' | 'line'; decorationOpacity: number; avatarSize: number; avatarCrop: 'full' | 'upper' };
  widget: { style: 'tech' | 'character'; glowOpacity: number; characterMaxFraction: number; nativeCharacterAsset?: string; characterCropTop: number; characterCropBottom: number };
}

const light: ThemeColors = {
  primary: '#7657F6', primaryPressed: '#6547E6', primarySoft: '#ECE8FF', background: '#F5F6F8', surface: '#FFFFFF', surfaceSecondary: '#F0F1F5',
  border: '#E4E5EA', borderSubtle: '#ECECF1', textPrimary: '#17151D', textSecondary: '#5E5A68', textMuted: '#777280', textDim: '#AAA5B1',
  success: '#10B981', successSoft: '#ECFDF5', warning: '#F59E0B', warningSoft: '#FFFBEB', danger: '#EF4444', dangerSoft: '#FEF2F2', info: '#3B82F6', infoSoft: '#EFF6FF', onPrimary: '#FFFFFF',
};
const dark: ThemeColors = {
  primary: '#9B82FF', primaryPressed: '#8468F4', primarySoft: '#28203F', background: '#0C0A10', surface: '#15121B', surfaceSecondary: '#1B1723',
  border: '#292431', borderSubtle: '#211D28', textPrimary: '#F7F5FA', textSecondary: '#C8C2D0', textMuted: '#928B9B', textDim: '#67616E',
  success: '#34D399', successSoft: '#102A22', warning: '#FBBF24', warningSoft: '#30240E', danger: '#FB7185', dangerSoft: '#32151C', info: '#60A5FA', infoSoft: '#13263D', onPrimary: '#120D20',
};
const hero: ThemePackLayout = { characterPosition: 'right', characterAnchor: 'bottom', characterScale: 1, characterOffsetX: 0, characterOffsetY: 0, characterZIndex: 2, vehicleScale: 1, vehicleOffsetX: 0, vehicleOffsetY: 0 };
const chiiHero = require('../assets/themes/anime-01/chii-hero.png') as ImageSourcePropType;
const animeLight: Partial<ThemeColors> = {
  primary: '#E88BAA', primaryPressed: '#D77698', primarySoft: '#FBE9F0', background: '#FAF8FB', surface: '#FFFDFE', surfaceSecondary: '#F7EEF5',
  border: '#EEDFE7', borderSubtle: '#F4EAF0', textPrimary: '#403541', textSecondary: '#716272', textMuted: '#928391', textDim: '#B9ABB5',
  info: '#B9A4F4', infoSoft: '#F0ECFC', onPrimary: '#FFFFFF',
};
const animeDark: Partial<ThemeColors> = {
  primary: '#F0A0BA', primaryPressed: '#DF89A8', primarySoft: '#3B2232', background: '#140E17', surface: '#211823', surfaceSecondary: '#2B1F2C',
  border: '#493444', borderSubtle: '#342633', textPrimary: '#FFF8FB', textSecondary: '#DCCBD6', textMuted: '#AD98A6', textDim: '#796873',
  info: '#B9A4F4', infoSoft: '#2E2745', onPrimary: '#24131C',
};

const manifests: Record<ThemePackId, ThemePackManifest> = {
  'default-tech': { schemaVersion: 1, id: 'default-tech', name: '默认科技', description: '冷白留白、克制紫光与清晰的数据层级。', version: '1.1.0', author: 'Nine Dashboard', minAppVersion: '1.6.19', available: true,
    colors: { light, dark }, layout: hero, dashboard: { hudStyle: 'arc', decorationOpacity: 0.1 }, widget: { style: 'tech', glowOpacity: 0.12, characterMaxFraction: 0.2 }, assets: {} },
  'anime-01': { schemaVersion: 1, id: 'anime-01', name: 'Anime Theme 01 · Chii', description: '奶白、樱粉与柔紫交织的 Persocom 柔光主题。', version: '1.0.0', author: 'Nine Dashboard', minAppVersion: '1.6.19', available: true,
    preview: chiiHero, colors: { light: animeLight, dark: animeDark },
    layout: { ...hero, characterPosition: 'edge', characterAnchor: 'bottom', characterScale: 0.86, characterOffsetX: -5, characterOffsetY: 2, characterZIndex: 2, vehicleScale: 0.9, vehicleOffsetX: -10 },
    dashboard: { hudStyle: 'line', decorationOpacity: 0.66, avatarSize: 58, avatarCrop: 'upper' }, widget: { style: 'character', glowOpacity: 0.13, characterMaxFraction: 0.17, nativeCharacterAsset: 'chii_hero', characterCropTop: 0, characterCropBottom: 0.4 },
    assets: { characterHero: chiiHero, tripCharacter: chiiHero, dashboardAvatar: chiiHero, widgetCharacter: chiiHero },
    dialogue: { home: ['今天也一起出发吧。'], trip: ['今天也走了很远呢。'], charging: ['正在补充能量……'], warning: ['好像有一点异常，要注意哦。'], enabledByDefault: true } },
};

const mergeColors = (mode: ResolvedThemeMode, value?: Partial<ThemeColors>): ThemeColors => ({ ...(mode === 'dark' ? dark : light), ...(value ?? {}) });

/** Local/downloaded manifests cross this boundary; incomplete packs safely inherit default-tech. */
export function normalizeThemePack(manifest: ThemePackManifest): ThemePack {
  const id = (manifest.id === 'anime-01' ? 'anime-01' : 'default-tech') as ThemePackId;
  return {
    ...manifest, id, colors: { light: mergeColors('light', manifest.colors.light), dark: mergeColors('dark', manifest.colors.dark) },
    typography: manifest.typography ?? {}, assets: manifest.assets ?? {},
    surfaces: { cardOpacity: 1, heroGlowOpacity: manifest.widget?.glowOpacity ?? 0.13 },
    borderStyle: id === 'anime-01' ? 'decorative' : 'hairline', radiusStyle: id === 'anime-01' ? 'rounded' : 'soft', shadowStyle: id === 'anime-01' ? 'soft' : 'minimal',
    pageBackground: 'ambient', decorations: { enabled: Object.values(manifest.assets ?? {}).some(Boolean) },
    hero: { ...hero, ...(manifest.layout ?? {}) }, dashboard: { hudStyle: manifest.dashboard?.hudStyle ?? 'arc', decorationOpacity: manifest.dashboard?.decorationOpacity ?? 0.1, avatarSize: manifest.dashboard?.avatarSize ?? 52, avatarCrop: manifest.dashboard?.avatarCrop ?? 'full' },
    widget: { style: manifest.widget?.style ?? 'tech', glowOpacity: manifest.widget?.glowOpacity ?? 0.12, characterMaxFraction: Math.min(0.2, Math.max(0, manifest.widget?.characterMaxFraction ?? 0.2)), nativeCharacterAsset: manifest.widget?.nativeCharacterAsset, characterCropTop: Math.max(0, Math.min(0.8, manifest.widget?.characterCropTop ?? 0)), characterCropBottom: Math.max(0.2, Math.min(1, manifest.widget?.characterCropBottom ?? 1)) },
  };
}

export const themePackManifests = manifests;
export const themePacks: Record<ThemePackId, ThemePack> = { 'default-tech': normalizeThemePack(manifests['default-tech']), 'anime-01': normalizeThemePack(manifests['anime-01']) };
export function resolveThemePack(id: string | null | undefined): ThemePack { return themePacks[id as ThemePackId] ?? themePacks['default-tech']; }
export function resolveThemeAsset(pack: ThemePack, key: keyof ThemeAssetMap, mode: ResolvedThemeMode): ThemeAsset | undefined {
  if (key === 'characterHero' && mode === 'dark') return pack.assets?.characterHeroDark ?? pack.assets?.characterHero ?? undefined;
  return pack.assets?.[key] ?? undefined;
}

export interface AppTheme { colors: ThemeColors; spacing: typeof spacing; radius: typeof radius; fontSize: typeof fontSize; fontWeight: typeof fontWeight; pack: ThemePack; resolvedMode: ResolvedThemeMode; isDark: boolean; }
