import { Stack } from 'expo-router';
import SettingsScreen from '../settings';

export default function MoreBatteryProfile() {
  return <><Stack.Screen options={{ headerShown: false }} /><SettingsScreen nested initialPane="电池硬件档案" /></>;
}
