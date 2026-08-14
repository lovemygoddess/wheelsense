import { NativeModules, NativeEventEmitter, Platform, type EmitterSubscription, type NativeModule } from 'react-native';

/**
 * Thin wrapper around the native `GnssStatusModule` (Android only).
 *
 * expo-location does not expose satellite / constellation info, so this native
 * bridge taps `LocationManager.registerGnssStatusCallback` directly. On iOS
 * (and unsupported Android) every call is a safe no-op and the listener never
 * fires.
 */
type NativeGnss = {
  startListen: () => Promise<void>;
  stopListen: () => Promise<void>;
  getConstants?: () => { supportsGnss?: boolean };
  addListener?: (event: string) => void;
  removeListeners?: (count: number) => void;
};

const Raw = (NativeModules as Record<string, NativeGnss | undefined>).GnssStatusModule;
export const gnssSupported: boolean = Platform.OS === 'android' && !!Raw;

export interface GnssConstellations {
  GPS: number;
  GLONASS: number;
  BEIDOU: number;
  GALILEO: number;
  QZSS: number;
  IRNSS: number;
  SBAS: number;
  UNKNOWN: number;
}

export interface GnssStatusData {
  constellations: GnssConstellations;
  totalSatellites: number;
  usedSatellites: number;
  /** 0 = none, 1 = weak, 2 = fair, 3 = good, 4 = strong */
  signalLevel: number;
}

/** Begin native GNSS status listening. No-op outside Android. */
export function startGnssStatus(): Promise<void> {
  if (!Raw) return Promise.resolve();
  return Raw.startListen();
}

/** Stop native GNSS status listening. No-op outside Android. */
export function stopGnssStatus(): Promise<void> {
  if (!Raw) return Promise.resolve();
  return Raw.stopListen();
}

/** Subscribe to `onGnssStatus` updates. Returns null outside Android. */
export function addGnssListener(cb: (status: GnssStatusData) => void): EmitterSubscription | null {
  if (!Raw) return null;
  const emitter = new NativeEventEmitter(Raw as unknown as NativeModule);
  return emitter.addListener('onGnssStatus', cb as (...args: unknown[]) => void);
}
