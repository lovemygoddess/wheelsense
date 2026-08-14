import { Stack } from 'expo-router';
import ThemeCenterScreen from '../../theme-center';

export default function MoreThemeCenter() {
  return <><Stack.Screen options={{ headerShown: false }} /><ThemeCenterScreen /></>;
}
