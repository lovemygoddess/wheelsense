import { Stack } from 'expo-router';
import SettingsScreen from '../settings';

export default function MoreVehicleSettings() {
  return <><Stack.Screen options={{ headerShown: false }} /><SettingsScreen nested initialPane="车辆设置" /></>;
}
