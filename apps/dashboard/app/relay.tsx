import { Stack } from 'expo-router';
import RelayScreen from './(tabs)/relay';

export default function RelayRoute() {
  return <><Stack.Screen options={{ headerShown: false }} /><RelayScreen /></>;
}
