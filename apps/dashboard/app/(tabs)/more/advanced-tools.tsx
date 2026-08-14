import { Stack } from 'expo-router';
import SettingsScreen from '../settings';

export default function MoreAdvancedTools() {
  return <><Stack.Screen options={{ headerShown: false }} /><SettingsScreen nested initialPane="高级设置" /></>;
}
