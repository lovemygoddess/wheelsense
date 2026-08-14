import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useColorScheme } from 'react-native';
import { resolveThemePack, type AppTheme, type ThemeMode, type ThemePackId, type WidgetThemeBehavior } from './themePacks';
import { fontSize, fontWeight, radius, spacing } from './theme';
import { syncWidgetTheme } from './widgetData';

const STORAGE_KEY = '@nine/theme-preferences/v1';
type Preferences = { mode: ThemeMode; themePack: ThemePackId; widgetThemeBehavior: WidgetThemeBehavior; dialogueEnabled: boolean };
const defaults: Preferences = { mode: 'system', themePack: 'default-tech', widgetThemeBehavior: 'app', dialogueEnabled: true };

interface ThemeContextValue extends Preferences {
  theme: AppTheme; colors: AppTheme['colors']; resolvedMode: 'light' | 'dark'; isDark: boolean; ready: boolean;
  setMode: (mode: ThemeMode) => Promise<void>; setThemePack: (id: ThemePackId) => Promise<void>;
  setWidgetThemeBehavior: (value: WidgetThemeBehavior) => Promise<void>; setDialogueEnabled: (value: boolean) => Promise<void>;
}
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [prefs, setPrefs] = useState<Preferences>(defaults);
  const prefsRef = useRef<Preferences>(defaults);
  const [ready, setReady] = useState(false);
  useEffect(() => { AsyncStorage.getItem(STORAGE_KEY).then(raw => {
    if (raw) { try { const restored = { ...defaults, ...JSON.parse(raw) }; prefsRef.current = restored; setPrefs(restored); } catch { /* retain safe defaults */ } }
  }).finally(() => setReady(true)); }, []);
  const resolvedMode = prefs.mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : prefs.mode;
  const pack = resolveThemePack(prefs.themePack);
  const theme = useMemo<AppTheme>(() => ({ colors: pack.colors[resolvedMode], spacing, radius, fontSize, fontWeight, pack, resolvedMode, isDark: resolvedMode === 'dark' }), [pack, resolvedMode]);
  useEffect(() => {
    if (!ready) return;
    void syncWidgetTheme({
      themePackId: pack.id, themeMode: prefs.mode, resolvedMode, behavior: prefs.widgetThemeBehavior,
      dialogueEnabled: prefs.dialogueEnabled, colors: pack.colors[resolvedMode], widgetStyle: pack.widget.style,
      lightColors: pack.colors.light, darkColors: pack.colors.dark,
      glowOpacity: pack.widget.glowOpacity,
      characterMaxFraction: pack.widget.characterMaxFraction,
      characterCropTop: pack.widget.characterCropTop,
      characterCropBottom: pack.widget.characterCropBottom,
      characterAssetName: pack.widget.nativeCharacterAsset ? `res://${pack.widget.nativeCharacterAsset}` : null,
      decorationAssetName: null, backgroundAssetName: null,
    });
  }, [ready, pack, prefs.mode, prefs.widgetThemeBehavior, prefs.dialogueEnabled, resolvedMode]);
  const update = useCallback(async (next: Partial<Preferences>) => {
    const value = { ...prefsRef.current, ...next };
    prefsRef.current = value;
    setPrefs(value);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }, []);
  const value = useMemo<ThemeContextValue>(() => ({ ...prefs, theme, colors: theme.colors, resolvedMode, isDark: theme.isDark, ready,
    setMode: mode => update({ mode }), setThemePack: themePack => update({ themePack }),
    setWidgetThemeBehavior: widgetThemeBehavior => update({ widgetThemeBehavior }), setDialogueEnabled: dialogueEnabled => update({ dialogueEnabled }),
  }), [prefs, theme, resolvedMode, ready, update]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useAppTheme must be used inside AppThemeProvider');
  return value;
}
