import { Stack } from 'expo-router';

/** More owns a real nested stack. The bottom tab only selects this stack; all
 * feature pages below it push/pop without replacing the top-level tab. */
export default function MoreStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
