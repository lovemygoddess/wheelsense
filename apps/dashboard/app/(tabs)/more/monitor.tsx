import { Stack } from 'expo-router';
import CameraScreen from '../camera';

export default function MoreMonitor() {
  return <><Stack.Screen options={{ headerShown: false }} /><CameraScreen /></>;
}
