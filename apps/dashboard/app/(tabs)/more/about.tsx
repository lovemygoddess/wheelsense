import { Stack } from 'expo-router';
import SettingsScreen from '../settings';

export default function MoreAbout() {
  return <><Stack.Screen options={{ headerShown: false }} /><SettingsScreen nested initialPane="关于本应用" /></>;
}
