import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchRelayStatus, fetchSnapshot, fetchVehicles } from './api';
import { useAuth } from './auth';
import type { RelayStatus, Snapshot, Vehicle } from './types';
import { useDemoMode } from './demo/DemoModeProvider';
import { DEMO_SN, getDemoRelay, getDemoSnapshot, getDemoVehicles } from './demo/demoData';

const SELECTED_KEY = 'vehicle_data_selected_sn';
const RELAY_CACHE_KEY = 'vehicle_data_relay_cache';

type RefreshResult = { vehicles: Vehicle[]; sn: string | null; snapshot: Snapshot | null; relay: RelayStatus | null };

type VehicleDataContextValue = {
  vehicles: Vehicle[];
  selectedSn: string | null;
  snapshot: Snapshot | null;
  relay: RelayStatus | null;
  loading: boolean;
  error: string | null;
  selectVehicle: (sn: string) => Promise<RefreshResult>;
  refreshAll: (sn?: string) => Promise<RefreshResult>;
  refreshSnapshot: () => Promise<Snapshot | null>;
  refreshRelay: (options?: { gpsActive?: boolean; riding?: boolean }) => Promise<RelayStatus | null>;
};

const VehicleDataContext = createContext<VehicleDataContextValue | null>(null);

export function VehicleDataProvider({ children }: { children: ReactNode }) {
  const { unlocked } = useAuth();
  const { isDemoMode, ready: demoReady } = useDemoMode();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedSn, setSelectedSn] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const seq = useRef(0);
  const snapshotInFlight = useRef<Promise<Snapshot | null> | null>(null);
  const relayInFlight = useRef<Promise<RelayStatus | null> | null>(null);

  const commitSn = useCallback((sn: string | null) => {
    selectedRef.current = sn;
    setSelectedSn(sn);
    // Demo selection is session-only; never overwrite the user's real SN.
    if (sn && !isDemoMode) void AsyncStorage.setItem(SELECTED_KEY, sn);
  }, [isDemoMode]);

  const refreshSnapshot = useCallback(async (): Promise<Snapshot | null> => {
    if (isDemoMode) {
      const value = getDemoSnapshot();
      setSnapshot(value);
      return value;
    }
    const sn = selectedRef.current;
    if (!sn || !unlocked) return null;
    if (snapshotInFlight.current) return snapshotInFlight.current;
    const task = fetchSnapshot(sn).then((value) => {
      if (selectedRef.current === sn) setSnapshot(value);
      return value;
    }).finally(() => { snapshotInFlight.current = null; });
    snapshotInFlight.current = task;
    return task;
  }, [isDemoMode, unlocked]);

  const refreshRelay = useCallback(async (options?: { gpsActive?: boolean; riding?: boolean }): Promise<RelayStatus | null> => {
    if (isDemoMode) {
      const value = getDemoRelay();
      setRelay(value);
      return value;
    }
    const sn = selectedRef.current;
    if (!sn || !unlocked) return null;
    if (relayInFlight.current) return relayInFlight.current;
    const task = fetchRelayStatus(sn, options).then((value) => {
      if (selectedRef.current === sn) {
        setRelay(value);
        void AsyncStorage.setItem(RELAY_CACHE_KEY, JSON.stringify({ sn, value }));
      }
      return value;
    }).finally(() => { relayInFlight.current = null; });
    relayInFlight.current = task;
    return task;
  }, [isDemoMode, unlocked]);

  const refreshAll = useCallback(async (overrideSn?: string): Promise<RefreshResult> => {
    if (!unlocked) return { vehicles: [], sn: null, snapshot: null, relay: null };
    if (isDemoMode) {
      const list = getDemoVehicles();
      const sn = DEMO_SN;
      setError(null);
      setVehicles(list);
      if (selectedRef.current !== sn) {
        setSnapshot(null); setRelay(null); commitSn(sn);
      }
      const demoSnapshot = getDemoSnapshot();
      const demoRelay = getDemoRelay();
      setSnapshot(demoSnapshot); setRelay(demoRelay); setLoading(false);
      return { vehicles: list, sn, snapshot: demoSnapshot, relay: demoRelay };
    }
    const requestId = ++seq.current;
    setError(null);
    try {
      const list = await fetchVehicles();
      const stored = overrideSn ?? selectedRef.current ?? await AsyncStorage.getItem(SELECTED_KEY);
      const sn = list.some((v) => v.sn === stored) ? stored : list[0]?.sn ?? null;
      if (requestId !== seq.current) return { vehicles: list, sn, snapshot: null, relay: null };
      setVehicles(list);
      if (sn !== selectedRef.current) {
        setSnapshot(null); setRelay(null); commitSn(sn);
      }
      if (!sn) return { vehicles: list, sn: null, snapshot: null, relay: null };
      const [freshSnapshot, freshRelay] = await Promise.all([fetchSnapshot(sn), fetchRelayStatus(sn)]);
      if (requestId === seq.current && selectedRef.current === sn) {
        setSnapshot(freshSnapshot); setRelay(freshRelay);
        void AsyncStorage.setItem(RELAY_CACHE_KEY, JSON.stringify({ sn, value: freshRelay }));
      }
      return { vehicles: list, sn, snapshot: freshSnapshot, relay: freshRelay };
    } catch (e) {
      const message = e instanceof Error ? e.message : '车辆数据加载失败';
      if (requestId === seq.current) setError(message);
      throw e;
    } finally {
      if (requestId === seq.current) setLoading(false);
    }
  }, [commitSn, isDemoMode, unlocked]);

  const selectVehicle = useCallback(async (sn: string) => {
    commitSn(sn); setSnapshot(null); setRelay(null);
    return refreshAll(sn);
  }, [commitSn, refreshAll]);

  useEffect(() => {
    if (!demoReady) return;
    if (!unlocked) {
      setVehicles([]); setSnapshot(null); setRelay(null); commitSn(null); setLoading(false);
      return;
    }
    setLoading(true);
    AsyncStorage.getItem(RELAY_CACHE_KEY).then((raw) => {
      if (!raw) return;
      try {
        const cached = JSON.parse(raw) as { sn: string; value: RelayStatus };
        if (!selectedRef.current || cached.sn === selectedRef.current) setRelay(cached.value);
      } catch { /* ignore damaged cache */ }
    }).catch(() => {});
    void refreshAll().catch(() => {});
  }, [demoReady, unlocked, refreshAll, commitSn]);

  useEffect(() => {
    if (!demoReady || !unlocked || !selectedSn) return;
    const snapshotTimer = setInterval(() => { void refreshSnapshot().catch(() => {}); }, 60_000);
    const relayTimer = setInterval(() => { void refreshRelay().catch(() => {}); }, 5_000);
    return () => { clearInterval(snapshotTimer); clearInterval(relayTimer); };
  }, [demoReady, isDemoMode, unlocked, selectedSn, refreshSnapshot, refreshRelay]);

  return <VehicleDataContext.Provider value={{ vehicles, selectedSn, snapshot, relay, loading, error, selectVehicle, refreshAll, refreshSnapshot, refreshRelay }}>{children}</VehicleDataContext.Provider>;
}

export function useVehicleData(): VehicleDataContextValue {
  const value = useContext(VehicleDataContext);
  if (!value) throw new Error('useVehicleData must be used inside VehicleDataProvider');
  return value;
}
