/**
 * ANT BMS BLE Hook for React Native.
 *
 * Protocol:
 *   SERVICE_UUID = 0000ffe0-...   NOTIFY_CHAR_UUID = 0000ffe1-...
 *   Poll 7E A1 01 00 00 F5 <crc16> AA 55 every 500ms (10-byte frame —
 *   the CRC + trailer are REQUIRED; the old 6-byte truncated command was
 *   silently discarded by the BMS, which is why nothing ever came back).
 *   Reassemble frames with extractFrames() from src/antBmsProtocol.ts
 *   (partial frames survive across notifies — the old local reassembler
 *   dropped them, so multi-packet status frames could never assemble).
 *   Parse with parseAntBmsFrame() from src/antBmsProtocol.ts
 *
 * Scan flow:
 *   connect() => startScan() — collects discovered devices into `scannedDevices`
 *   and surfaces a picker in the UI. The user then picks a device which triggers
 *   connectToDevice(device). On success the device id is persisted; the next
 *   visit autoConnect()s straight to it without the picker.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, type Device, type Characteristic, type Subscription } from 'react-native-ble-plx';
import { toByteArray as b64ToByteArray, fromByteArray as b64FromByteArray } from 'base64-js';
import * as SecureStore from 'expo-secure-store';
import { parseAntBmsFrame, mergeFrames, extractFrames, crc16Modbus, filterImplausibleValues, hasPlausibleStatusData, type AntBmsFrame } from './antBmsProtocol';

const TAG = '[BLE]';
const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';
const POLL_INTERVAL_MS = 500;
const SCAN_TIMEOUT_MS = 12_000;
const STORE_ID_KEY = 'antBmsLastDeviceId';
const STORE_NAME_KEY = 'antBmsLastDeviceName';

/** Build the full 10-byte poll frame: 7E A1 fn addr_lo addr_hi value crc_lo crc_hi AA 55. */
function buildPollCommand(): Uint8Array {
  const head = new Uint8Array([0x7E, 0xA1, 0x01, 0x00, 0x00, 0xF5]);
  const crc = crc16Modbus(head, 1, 6);
  return new Uint8Array([...head, crc & 0xFF, (crc >> 8) & 0xFF, 0xAA, 0x55]);
}
const POLL_COMMAND = buildPollCommand();

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

/** A parsed BMS frame with its CRC validation result attached (from the parser). */
export type BmsFrame = AntBmsFrame & { crcOk: boolean };

/** Lightweight descriptor kept in React state for the picker UI. */
export interface ScannedDevice {
  id: string;
  name: string;
  rssi: number | null;
  /** True when the name looks like an ANT-BMS broadcast — used to hint the user. */
  matched: boolean;
}

function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

function displayName(device: Device | null): string {
  const n = (device?.name ?? device?.localName ?? '').trim();
  return n || '(未知名称)';
}

function looksLikeBms(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('ant') || n.includes('bms');
}

export function useAntBmsBluetooth() {
  const managerRef = useRef<BleManager | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<BmsFrame | null>(null);

  // ── Scan state (exposed for the picker UI) ──
  const [scannedDevices, setScannedDevices] = useState<ScannedDevice[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  const connectedDeviceRef = useRef<Device | null>(null);
  const charRef = useRef<Characteristic | null>(null);
  const reassemblyBuffer = useRef<Uint8Array>(new Uint8Array(0));
  const latestFrameRef = useRef<BmsFrame | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());
  /** Device id remembered from the last successful connection (auto-connect). */
  const savedIdRef = useRef<string | null>(null);
  /** Indirection so the scan callback (defined before connectToDevice) can reach it. */
  const connectToDeviceRef = useRef<(d: ScannedDevice) => Promise<boolean>>(async () => false);
  /** Active BLE notify subscription — must be removed before reconnect/disconnect,
   *  otherwise each (re)subscribe stacks a handler and every notify fires
   *  handleNotify multiple times. */
  const monitorSubRef = useRef<Subscription | null>(null);

  const handleNotify = (value: string | null) => {
    if (!value) return;
    const bytes = b64ToByteArray(value);
    reassemblyBuffer.current = concatBuffers(reassemblyBuffer.current, bytes);
    // Hard cap (M22): extractFrames already drops headerless garbage, but a
    // pathological stream of false 7E A1 headers could still pin bytes in
    // `rest`. 4KB ≈ 27 max-size status frames — far beyond any real burst.
    if (reassemblyBuffer.current.length > 4096) {
      reassemblyBuffer.current = reassemblyBuffer.current.subarray(reassemblyBuffer.current.length - 512);
    }
    const { frames, rest } = extractFrames(reassemblyBuffer.current);
    reassemblyBuffer.current = rest;
    for (const frameBytes of frames) {
      const parsed = parseAntBmsFrame(frameBytes);
      if (!parsed.ok) continue;
      // M6: sanity-filter field values and drop frames that carry nothing
      // plausible (misaligned parse). Note we can't hard-gate on crcOk —
      // this BMS variant's response CRC doesn't match MODBUS by design.
      const clean = filterImplausibleValues(parsed.frame);
      if (!hasPlausibleStatusData(clean)) continue;
      const merged = mergeFrames(latestFrameRef.current, clean);
      latestFrameRef.current = { ...merged, crcOk: parsed.crcOk };
      setFrame(latestFrameRef.current);
    }
  };

  const startNotifications = useCallback(async (device: Device) => {
    // Remove any stale notify subscription before (re)subscribing — a reconnect
    // would otherwise stack handlers and fire handleNotify multiple times.
    monitorSubRef.current?.remove();
    monitorSubRef.current = null;
    await device.connect();
    await device.discoverAllServicesAndCharacteristics();
    const services = await device.services();
    const svc = services.find(s => s.uuid.toLowerCase() === SERVICE_UUID);
    if (!svc) throw new Error('Service 0xFFE0 not found');
    const chars = await svc.characteristics();
    const char = chars.find(c => c.uuid.toLowerCase() === NOTIFY_UUID);
    if (!char) throw new Error('Characteristic 0xFFE1 not found');
    charRef.current = char;
    monitorSubRef.current = char.monitor((err, c) => {
      if (err) {
        if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
        setError(err.message || 'BLE 连接中断');
        setStatus('disconnected');
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        // Capture the device AT ARM TIME and re-verify at fire time (M2):
        // if the user manually connected a different device (or disconnected
        // intentionally) within the 5s window, this timer must do nothing —
        // the old code fired startNotifications(devA) unconditionally, which
        // removed device B's fresh subscription and hijacked the connection.
        const lostDevice = device;
        reconnectTimerRef.current = setTimeout(async () => {
          reconnectTimerRef.current = null;
          if (connectedDeviceRef.current !== lostDevice) return;
          try {
            setStatus('reconnecting');
            await startNotifications(lostDevice);
          } catch (e: any) {
            setError(e instanceof Error ? e.message : '重连失败');
            setStatus('error');
          }
        }, 5000);
        return;
      }
      if (c?.value) handleNotify(c.value);
    });
    setStatus('connected');
    setDeviceName(device.name ?? '(unknown)');
    // Persist for auto-connect on the next visit. Fire-and-forget — a
    // failed write just means the user picks from the list again next time.
    savedIdRef.current = device.id;
    void SecureStore.setItemAsync(STORE_ID_KEY, device.id).catch(() => {});
    void SecureStore.setItemAsync(STORE_NAME_KEY, device.name ?? '').catch(() => {});
    // M4: clear any stale poll interval before arming a new one — a concurrent
    // connectToDevice path could otherwise stack two 500ms pollers.
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    pollTimerRef.current = setInterval(async () => {
      try {
        if (charRef.current) {
          const payload = b64FromByteArray(POLL_COMMAND);
          await charRef.current.writeWithoutResponse(payload);
        }
      } catch { /* will retry next tick */ }
    }, POLL_INTERVAL_MS);
  }, []);

  async function requestBlePermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    try {
      if (Platform.Version >= 31) {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        const allOk = Object.values(granted).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
        console.warn(`${TAG} permissions (Android 12+):`, JSON.stringify(granted), '→', allOk);
        return allOk;
      } else {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        const ok = granted === PermissionsAndroid.RESULTS.GRANTED;
        console.warn(`${TAG} permissions (Android <=11):`, granted, '→', ok);
        return ok;
      }
    } catch (e) {
      console.warn(`${TAG} Permission request error:`, e);
      return false;
    }
  }

  /** Stop an in-flight scan and clear its timeout — idempotent. */
  const stopScan = useCallback(() => {
    if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
    try { managerRef.current?.stopDeviceScan(); } catch { /* already stopped */ }
    setIsScanning(false);
  }, []);

  /** Cancel a pending auto-reconnect — any INTENTIONAL connect/scan must do
   *  this, otherwise the armed 5s timer later fires startNotifications() on
   *  the old device and tears down the new connection (M2). */
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
  }, []);

  /**
   * Begin scanning for BLE devices. Discovered devices accumulate in
   * `scannedDevices` so the caller can render a picker. The scan auto-stops
   * after SCAN_TIMEOUT_MS. This does NOT auto-connect — call connectToDevice()
   * with the user's choice.
   */
  const startScan = useCallback(async () => {
    clearReconnectTimer(); // intentional new flow supersedes a pending reconnect (M2)
    setError(null);
    setDeviceName(null);
    setFrame(null);
    knownIdsRef.current = new Set();
    setScannedDevices([]);
    setStatus('connecting');
    setIsScanning(true);
    if (!managerRef.current) managerRef.current = new BleManager();
    // Load the remembered device so scan results can auto-connect to it.
    savedIdRef.current = await SecureStore.getItemAsync(STORE_ID_KEY).catch(() => null);
    console.log(`${TAG} startScan(): beginning device scan`);

    // 1. Permissions
    const hasPerms = await requestBlePermissions();
    if (!hasPerms) {
      console.warn(`${TAG} startScan(): missing permissions, aborting`);
      setError('缺少蓝牙权限，请在系统设置中允许');
      setStatus('error');
      stopScan();
      return;
    }

    // 2. Bluetooth powered on?
    try {
      const btState = await managerRef.current.state();
      console.log(`${TAG} bluetooth adapter state: ${btState}`);
      if (btState !== 'PoweredOn') {
        setError('蓝牙未开启，请先打开蓝牙开关');
        setStatus('error');
        stopScan();
        return;
      }
    } catch (e) {
      console.warn(`${TAG} state() check threw:`, e);
    }

    // 3. Timeout safety — surface "no devices" instead of silently hanging.
    scanTimerRef.current = setTimeout(() => {
      console.log(`${TAG} scan timed out after ${SCAN_TIMEOUT_MS}ms`);
      stopScan();
      setStatus('idle');
      if (knownIdsRef.current.size === 0) setError('扫描超时，未找到任何蓝牙设备');
      else setError('未匹配到 ANT-BMS 设备，请手动选择列表中的设备');
    }, SCAN_TIMEOUT_MS);

    const onResult = (err: Error | null, device: Device | null) => {
      if (err) {
        console.warn(`${TAG} scan error:`, err.message);
        stopScan();
        setError(err.message || '蓝牙扫描出错');
        setStatus('error');
        return;
      }
      if (!device) return;
      const name = displayName(device);
      const id = device.id;
      // Auto-connect when the remembered device shows up — no picker tap needed.
      if (savedIdRef.current && id === savedIdRef.current) {
        console.log(`${TAG} remembered device found: "${name}" (${id}) — auto-connecting`);
        void connectToDeviceRef.current({ id, name, rssi: device.rssi, matched: true });
        return;
      }
      if (knownIdsRef.current.has(id)) return; // dedupe
      knownIdsRef.current.add(id);
      const matched = looksLikeBms(name);
      console.log(`${TAG} discovered: id="${id}" name="${name}" rssi=${device.rssi ?? '—'} matched=${matched}`);
      setScannedDevices(prev => [...prev, { id, name, rssi: device.rssi, matched }]);
    };

    // Scan ALL devices (no UUID filter) — many BMS don't advertise FFE0 in broadcast.
    try {
      managerRef.current.startDeviceScan(null, null, onResult);
    } catch (e: any) {
      console.warn(`${TAG} startDeviceScan threw:`, e?.message ?? e);
      setError(e instanceof Error ? e.message : '扫描启动失败');
      setStatus('error');
      stopScan();
    }
  }, [startNotifications, stopScan, clearReconnectTimer]);

  /**
   * Connect to a specific device from the scan results. Stops the scan first
   * so competing resources are freed, then opens the GATT connection and
   * begins polling. Returns true on success so autoConnect() can fall back
   * to a scan when the remembered device is out of range.
   */
  const connectToDevice = useCallback(async (device: ScannedDevice): Promise<boolean> => {
    if (!managerRef.current) managerRef.current = new BleManager();
    clearReconnectTimer(); // intentional pick supersedes a pending reconnect (M2)
    stopScan();
    setStatus('connecting');
    setError(null);
    setDeviceName(device.name);
    console.log(`${TAG} connectToDevice(): connecting to "${device.name}" (${device.id})`);
    try {
      // Use the manager's connectById path so we don't need the raw scan record.
      // ble-plx's startDeviceScan already retained the device in its internal
      // cache, so connectToDevice resolves to the same Device instance.
      const connected = await managerRef.current.connectToDevice(device.id);
      connectedDeviceRef.current = connected;
      await startNotifications(connected);
      return true;
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : '连接失败';
      console.warn(`${TAG} connectToDevice error:`, msg);
      setError(msg);
      setStatus('error');
      return false;
    }
  }, [startNotifications, stopScan, clearReconnectTimer]);
  connectToDeviceRef.current = connectToDevice;

  /**
   * Silent reconnect path for the BMS tab: if a device was connected before,
   * try it directly (no scan, no picker). Returns false when there is no
   * remembered device — the UI then shows the manual "连接 ANT-BMS" flow.
   * On connection failure the hook falls through to startScan() so a changed
   * MAC or a first-time setup still ends in the picker.
   */
  const autoConnect = useCallback(async (): Promise<boolean> => {
    const savedId = await SecureStore.getItemAsync(STORE_ID_KEY).catch(() => null);
    if (!savedId) return false;
    const savedName = (await SecureStore.getItemAsync(STORE_NAME_KEY).catch(() => null)) ?? 'ANT-BMS';
    savedIdRef.current = savedId;
    console.log(`${TAG} autoConnect(): trying remembered device "${savedName}" (${savedId})`);
    const ok = await connectToDevice({ id: savedId, name: savedName, rssi: null, matched: true });
    if (!ok) {
      console.log(`${TAG} autoConnect(): direct connect failed, falling back to scan`);
      setError(null);
      void startScan();
    }
    return true;
  }, [connectToDevice, startScan]);

  /** Alias kept so the StatusCard button's existing handler signature still works. */
  const connect = useCallback(() => { void startScan(); }, [startScan]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    // M1: stop the NATIVE scan too — clearing only the UI timer left the
    // adapter scanning forever, leaking resources and auto-connecting to the
    // very device the user just cancelled. stopScan() is idempotent.
    stopScan();
    // Remove the BLE notify subscription so a later reconnect doesn't stack handlers.
    monitorSubRef.current?.remove();
    monitorSubRef.current = null;
    connectedDeviceRef.current?.cancelConnection().catch(() => {});
    connectedDeviceRef.current = null;
    charRef.current = null;
    reassemblyBuffer.current = new Uint8Array(0);
    latestFrameRef.current = null;
    setError(null);
    setStatus('idle');
    setDeviceName(null);
    setFrame(null);
    setScannedDevices([]);
  }, [stopScan]);

  useEffect(() => () => {
    disconnect();
    managerRef.current?.destroy();
  }, [disconnect]);

  return {
    status, deviceName, error, frame,
    scannedDevices, isScanning,
    startScan, connectToDevice, connect, disconnect, autoConnect,
  };
}