import AsyncStorage from '@react-native-async-storage/async-storage';

const DEMO_MODE_KEY = 'app_demo_mode_enabled';
let enabled = false;
let ready = false;
let initialized: Promise<boolean> | null = null;
const listeners = new Set<(value: boolean) => void>();

export function isDemoModeSync(): boolean { return enabled; }
export function isDemoModeReady(): boolean { return ready; }

export function subscribeDemoMode(listener: (value: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function initializeDemoMode(): Promise<boolean> {
  if (initialized) return initialized;
  initialized = AsyncStorage.getItem(DEMO_MODE_KEY).then((raw) => {
    enabled = raw === '1';
    ready = true;
    listeners.forEach((listener) => listener(enabled));
    return enabled;
  }).catch(() => {
    ready = true;
    enabled = false;
    return false;
  });
  return initialized;
}

export async function setDemoModeEnabled(value: boolean): Promise<void> {
  enabled = value;
  ready = true;
  await AsyncStorage.setItem(DEMO_MODE_KEY, value ? '1' : '0');
  listeners.forEach((listener) => listener(enabled));
}
