import { Stack } from 'expo-router';
import SettingsScreen from '../settings';

export default function MoreConnectionAccount() {
  return <><Stack.Screen options={{ headerShown: false }} /><SettingsScreen nested initialPane="九号账号" /></>;
}
