import { Stack } from 'expo-router';
import SettingsScreen from '../settings';

export default function MoreNotificationSettings() {
  return <><Stack.Screen options={{ headerShown: false }} /><SettingsScreen nested initialPane="通知设置" /></>;
}
