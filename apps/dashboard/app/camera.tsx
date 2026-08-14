import { Stack } from 'expo-router';
import CameraScreen from './(tabs)/camera';

export default function CameraRoute() {
  return <><Stack.Screen options={{ headerShown: false }} /><CameraScreen /></>;
}
