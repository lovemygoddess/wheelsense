import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '../src/auth';
import { Text, View } from 'react-native';
import { AppText } from '../src/components/AppText';
import { VehicleDataProvider } from '../src/vehicleData';
import { AppThemeProvider, useAppTheme } from '../src/ThemeProvider';
import { DemoModeProvider, useDemoMode } from '../src/demo/DemoModeProvider';
import { DemoBadge } from '../src/components/DemoBadge';

function RootNav() {
  const { ready, unlocked } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const { colors } = useAppTheme();
  const { ready: demoReady } = useDemoMode();

  useEffect(() => {
    if (!ready) return;
    const onLogin = segments[0] === 'login';
    if (!unlocked && !onLogin) router.replace('/login');
    else if (unlocked && onLogin) router.replace('/');
  }, [ready, unlocked, segments, router]);

  if (!ready || !demoReady) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <AppText style={{ color: colors.textMuted }}>加载中...</AppText>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="theme-center" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="camera" options={{ headerShown: false }} />
      <Stack.Screen name="relay" options={{ headerShown: false }} />
      <Stack.Screen name="charging-detail" options={{ headerShown: false }} />
      <Stack.Screen name="+not-found" options={{ title: '404' }} />
    </Stack>
    <DemoBadge />
    </View>
  );
}

export default function RootLayout() {
  return (
    <AppThemeProvider>
      <AuthProvider>
        <DemoModeProvider>
          <VehicleDataProvider><RootNav /></VehicleDataProvider>
        </DemoModeProvider>
      </AuthProvider>
    </AppThemeProvider>
  );
}
