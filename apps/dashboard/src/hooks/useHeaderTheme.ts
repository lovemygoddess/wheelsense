/**
 * Each tab screen paints its own immersive header (defined in `headerThemes`).
 * This hook tells the OS status bar which contrast to use when the screen
 * gains focus and gives the caller the top safe-area inset so page content
 * can flow under the header without crossing the top notch.
 */
import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { HeaderTheme } from '../theme';
import { useAppTheme } from '../ThemeProvider';

export function useHeaderTheme(theme: HeaderTheme): { top: number } {
  const insets = useSafeAreaInsets();
  const top = Math.max(insets.top, Platform.OS === 'android' ? 28 : 12);
  const { isDark } = useAppTheme();
  useFocusEffect(useCallback(() => {
    StatusBar.setStyle(isDark ? 'light' : 'dark');
    return () => {
      // No reset — the next focused screen overwrites in its own useFocusEffect.
    };
  }, [theme, isDark]));
  return { top };
}
