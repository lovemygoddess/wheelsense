import { Stack } from 'expo-router';
import SettingsScreen from '../../settings';

/** Widget settings is a direct More destination, not a child of the old
 * settings aggregation page. */
export default function MoreWidgetSettings() {
  return <><Stack.Screen options={{ headerShown: false }} /><SettingsScreen nested initialPane="桌面小组件" /></>;
}
