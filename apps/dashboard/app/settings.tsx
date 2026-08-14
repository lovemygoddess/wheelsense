import { Stack } from 'expo-router';
import SettingsScreen from './(tabs)/settings';

export default function SettingsRoute() {
  return <><Stack.Screen options={{ headerShown: false }} /><SettingsScreen /></>;
}
