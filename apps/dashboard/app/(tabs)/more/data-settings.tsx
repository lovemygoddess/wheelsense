import { Stack } from 'expo-router';
import SettingsScreen from '../settings';

export default function MoreDataSettings() {
  return <><Stack.Screen options={{ headerShown: false }} /><SettingsScreen nested initialPane="数据设置" /></>;
}
