import { Stack } from 'expo-router';
import RelayScreen from '../relay';

export default function MoreRelay() {
  return <><Stack.Screen options={{ headerShown: false }} /><RelayScreen /></>;
}
