import type { AmapWeather, AlarmItem, TpmsCurrent, TpmsWheel } from '../api';
import type {
  Account, BatteryOverview, ChargeTimeEstimate, PrimaryTelemetry,
  RelayBmsFrame, RelayCommand, RelayConfigData, RelayStatus, Ride, RidesMeta, RidesResponse,
  SettingsPayload, Snapshot, TrailSpeedAnalysis, Vehicle,
} from '../types';
import { demoBatteryFixture, getDemoBatteryBms, getDemoBatteryCalibration, getDemoBatterySnapshot, getDemoChargeEvents, getDemoVoltageSeries } from './demoBattery';

/** Stable, non-sensitive data used by Demo Mode. Nothing in this module is
 * derived from the user's selected vehicle or server response. */
export const DEMO_SN = 'DEMO-E300P-01';
export const DEMO_LOCATION = { latitude: 39.9042, longitude: 116.4074, description: '北京市东城区 · 演示位置' };

let simulatorStartedAt = Date.now();
export function resetDemoSimulation(): void { simulatorStartedAt = Date.now(); }

function elapsedSeconds(now = Date.now()): number {
  return Math.max(0, (now - simulatorStartedAt) / 1000);
}

/** Deterministic, smooth speed loop: 0 → 8 → 18 → 32 → 26 → 42 → 35. */
export function getDemoMotion(now = Date.now()): { speedKmh: number; acceleration: number; powerW: number; voltageV: number } {
  const keyframes = [0, 8, 18, 32, 26, 42, 35, 0];
  const segmentSeconds = 4;
  const cycle = segmentSeconds * (keyframes.length - 1);
  const phase = elapsedSeconds(now) % cycle;
  const index = Math.min(keyframes.length - 2, Math.floor(phase / segmentSeconds));
  const fraction = (phase - index * segmentSeconds) / segmentSeconds;
  const eased = fraction * fraction * (3 - 2 * fraction);
  const speedKmh = keyframes[index] + (keyframes[index + 1] - keyframes[index]) * eased;
  const previousPhase = (phase - 0.5 + cycle) % cycle;
  const previousIndex = Math.min(keyframes.length - 2, Math.floor(previousPhase / segmentSeconds));
  const previousFraction = (previousPhase - previousIndex * segmentSeconds) / segmentSeconds;
  const previousEased = previousFraction * previousFraction * (3 - 2 * previousFraction);
  const previousSpeed = keyframes[previousIndex] + (keyframes[previousIndex + 1] - keyframes[previousIndex]) * previousEased;
  const acceleration = (speedKmh - previousSpeed) / 3.6 / 0.5;
  const powerW = Math.round(70 + speedKmh * 13 + Math.abs(acceleration) * 135);
  const voltageV = 54.6 - Math.min(0.18, elapsedSeconds(now) * 0.00018);
  return { speedKmh, acceleration, powerW, voltageV };
}

function isoNow(now = Date.now()): string { return new Date(now).toISOString(); }

const demoDiagnostics: PrimaryTelemetry['diagnostics'] = {
  bms_soc_pct: 82, bms_age_seconds: 0, bms_fresh: true, bms_usable: true, bms_source: 'relay',
  voltage_soc_pct: 81.7, learned_soc_pct: 82, vendor_soc_pct: 82, range_wh_per_km: 18.2,
  range_confidence: 0.94, range_note: '演示数据',
};

export function getDemoPrimary(now = Date.now()): PrimaryTelemetry {
  const elapsed = elapsedSeconds(now);
  const soc = Math.max(81.4, 82 - elapsed / 3600 * 0.18);
  return {
    soc_pct: soc, range_km: 106.8 - Math.min(0.8, elapsed / 3600 * 0.2), source: 'bms', source_detail: 'relay',
    updated_at: isoNow(now), age_seconds: 0, fresh: true, quality: 'live', confidence: 0.96,
    degraded_reason: null, usable_for_range: true, usable_for_safety: true, diagnostics: { ...demoDiagnostics, bms_soc_pct: soc },
  };
}

export function getDemoSnapshot(now = Date.now()): Snapshot {
  const motion = getDemoMotion(now);
  const primary = getDemoPrimary(now);
  const battery = primary.soc_pct;
  return {
    timestamp: isoNow(now), battery, endurance: primary.range_km, ai_estimate_mileage: 106.8,
    precise_estimate_mileage: primary.range_km, charging: false, power: motion.powerW, lock: 1,
    bms_voltage: motion.voltageV, batt_temp: 31.8 + Math.sin(elapsedSeconds(now) / 18) * 0.35,
    bms_cycles: 126, bms_score: 94, charging_power: null, primary,
    calibrated_endurance_km: primary.range_km, soc_voltage_pct: 81.7, bms_soc_pct: battery,
    soc_source: 'bms', soc_calibrated_pct: 82, remain_charge_time: null,
    location: DEMO_LOCATION, widget_token: null,
  };
}

export function getDemoVehicle(): Vehicle {
  return {
    sn: DEMO_SN, name: '演示车辆', model: 'E300P Demo', color: '曜石紫', vehicle_name_zh: '演示车辆',
    image_url: null, custom_image_url: null, latest: getDemoSnapshot(), effective_cycle_count: 126, total_mileage_km: 12586,
  };
}

export function getDemoVehicles(): Vehicle[] { return [getDemoVehicle()]; }

export function getDemoBms(now = Date.now()): RelayBmsFrame {
  const motion = getDemoMotion(now);
  const fixture = getDemoBatteryBms();
  return {
    ...fixture, total_voltage_v: demoBatteryFixture.packVoltageV,
    current_a: motion.powerW / demoBatteryFixture.packVoltageV, power_w: motion.powerW,
    soc_pct: getDemoPrimary(now).soc_pct,
  };
}

export function getDemoRelay(now = Date.now()): RelayStatus {
  return {
    present: true, device_sn: DEMO_SN, connected: true, board_connected: true, board_fresh: true,
    board_state: 'live', board_frame_age_seconds: 0, board_link_age_seconds: 0, ble_status: '已连接演示保护板',
    bms: getDemoBms(now), phone_battery_level_pct: 86, phone_battery_temp_c: 32.4 + Math.sin(elapsedSeconds(now) / 25) * 0.2,
    phone_charging: false, phone_battery_voltage_v: 4.08, phone_screen_on: true, last_report_at: isoNow(now), age_seconds: 0,
    poll_ms: 5000, ambient: { temp_c: 26.8, humidity_pct: 54, sensor_battery_mv: 2980, rssi: -48, fresh: true, age_seconds: 0, captured_at: isoNow(now) },
    app_ver: 'demo-relay 1.0',
  };
}

function demoWheel(position: 'front' | 'rear', pressure: number, temp: number, now: number): TpmsWheel {
  return { position, pressure, temp_c: temp, temp_candidate: false, checksum_ok: true, token: `demo-${position}`,
    rssi: -45, updated_at: isoNow(now), age_seconds: 0, capture_id: 0, status: 'normal' };
}

export function getDemoTpms(now = Date.now()): TpmsCurrent {
  const wobble = Math.sin(elapsedSeconds(now) / 30) * 0.01;
  return { ok: true, generated_at: isoNow(now), front: demoWheel('front', 2.18 + wobble, 28, now), rear: demoWheel('rear', 2.22 + wobble, 30, now), temp_available: true, temp_note: '演示数据', note: '演示模式：不会读取真实胎压' };
}

export function getDemoBatteryOverview(sn = DEMO_SN, hours = 24): BatteryOverview {
  const latest = getDemoBatterySnapshot();
  const relay = getDemoBatteryBms();
  const primary = latest.primary!;
  const estimate: ChargeTimeEstimate = { supported: true, reason: '演示电池 fixture', method: 'bms_capacity', remaining_min: 0,
    elapsed_min: 0, predicted_total_min: 52, current_voltage: demoBatteryFixture.packVoltageV, bms_full_charge_voltage: demoBatteryFixture.fullChargeVoltageV,
    training_events: 6, training_samples: 42, confidence: 0.93, soc_used: demoBatteryFixture.socPct,
    soc_source: 'bms_capacity', capacity_total_ah: demoBatteryFixture.capacityTotalAh, capacity_remaining_ah: demoBatteryFixture.capacityRemainingAh,
    capacity_to_fill_ah: demoBatteryFixture.capacityTotalAh - demoBatteryFixture.capacityRemainingAh, charge_current_a: 7.8, charge_power_w: 442,
    cv_factor: 1.06, note: '演示模式：独立电池 fixture', };
  return {
    device: { sn, name: '演示车辆', model: 'E300P Demo' }, latest, latest_at: latest.timestamp, primary, is_charging: false,
    range_estimate: { effective_endurance_km: primary.range_km ?? 104.2, calibrated_soc_pct: demoBatteryFixture.socPct,
      soc_voltage_pct: 79.8, bms_soc_pct: demoBatteryFixture.socPct, soc_source: 'bms', vendor_soc_pct: 80.9, wh_per_km: 19.6, confidence: 0.93, note: '独立演示电池 fixture' },
    charge_time_estimate: estimate, charge_power_w: 0, ant_bms_displayed_power_w: 0, charge_power_deviation_pct: 0,
    ant_bms_measured_current_a: Math.abs(demoBatteryFixture.currentA), charge_current_effective_a: Math.abs(demoBatteryFixture.currentA), charge_current_deviation_pct: 0, relay,
    charge_source: 'relay_live', charge_events: getDemoChargeEvents(), calibration: getDemoBatteryCalibration(), voltage_series: getDemoVoltageSeries(hours), window_hours: hours, generated_at: isoNow(),
  };
}

function rideAt(anchor: Date, index: number): Ride {
  const start = new Date(anchor.getTime() - index * 86400000 - (index % 3) * 3600000);
  start.setHours(7 + (index % 4), 20 + (index % 3) * 7, 0, 0);
  const durationMin = 36 + (index % 5) * 7;
  const end = new Date(start.getTime() + durationMin * 60000);
  const mileage = Number((12.8 + (index % 6) * 3.4 + (index % 2) * 1.2).toFixed(1));
  const avg = Number((mileage / (durationMin / 60)).toFixed(1));
  return { id: `demo-ride-${start.getTime()}`, started_at: start.toISOString(), ended_at: end.toISOString(), mileage,
    energy: Number((mileage * 18.2).toFixed(1)), energy_source: 'bms_interval', energy_coverage: 0.98,
    wh_per_km: 18.2, avg_speed_kph: avg, max_speed_kph: Number((avg + 10 + index % 4).toFixed(1)) };
}

export function getDemoRides(month?: string): RidesResponse {
  const now = new Date();
  const ym = month ?? `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const year = Number(ym.slice(0, 4)); const monthIndex = Number(ym.slice(4)) - 1;
  const anchor = new Date(year, monthIndex, Math.min(monthIndex === now.getMonth() && year === now.getFullYear() ? now.getDate() : 24, 28));
  const rides = Array.from({ length: 12 }, (_, i) => rideAt(anchor, i));
  const monthMileage = rides.reduce((sum, r) => sum + r.mileage, 0);
  const monthEnergy = rides.reduce((sum, r) => sum + (r.energy ?? 0), 0);
  const meta: RidesMeta = { month: ym, month_mileage: Number(monthMileage.toFixed(1)), month_energy: Number(monthEnergy.toFixed(1)), month_duration: rides.reduce((sum, r) => sum + (new Date(r.ended_at!).getTime() - new Date(r.started_at!).getTime()) / 60000, 0), month_ride_count: rides.length,
    month_daily: rides.map(r => r.mileage), wh_per_km_learned: 18.2, wh_per_km_learned_samples: 68, wh_per_km_source: 'bms_measured' };
  return { rides, meta };
}

export function getDemoRideTrail(rideId: string): TrailSpeedAnalysis {
  const duration = 2700;
  const series = Array.from({ length: 48 }, (_, i) => ({ t: Math.round(i * duration / 47), v: Number((22 + 11 * Math.sin(i / 5) + 4 * Math.sin(i / 2.5)).toFixed(1)) }));
  const top = Math.max(...series.map(p => p.v));
  return { ride_id: rideId, point_count: series.length, duration_sec: duration, speed_series: series, top_speed_kph: top, top_speed_method: 'demo_simulator', top_speed_peaks: [{ t: 1680, v: top }, { t: 2340, v: top - 1.2 }], top_speed_note: '演示速度曲线' };
}

export function getDemoAccount(): Account { return { username: 'demo@example.com', avatar: '', phone: '138****0000' }; }

export function getDemoSettings(sn = DEMO_SN): SettingsPayload {
  return { device_sn: sn, readonly: { chemistry_type: 'Li-ion', cell_series_count: 14 }, priors: { bms_full_charge_voltage: 60.9, bms_cutoff_voltage: 42, max_charge_current_a: 10, charger_output_current_a: 8, ant_bms_displayed_power_w: 420, ant_bms_measured_current_a: 8, nominal_voltage: 50.4, nominal_capacity_ah: 95, capacity_tolerance_pct: 5 }, thresholds: { temp_bucket_cold_max_c: 5, temp_bucket_warm_max_c: 35, plateau_voltage_delta: 0.18, plateau_min_minutes: 12, capacity_ema_alpha_base: 0.2 }, priors_set_at: isoNow(), wh_per_km_current: 18.2, total_calibration_samples: 68, cycle_count_baseline: 120, cycle_count_baseline_wh: 650000, odometer_baseline_km: 12000, odometer_baseline_ride_km: 586 };
}

export function getDemoRelayConfig(sn = DEMO_SN): RelayConfigData { return { device_sn: sn, idle_ms: 120000, ride_ms: 1000, low_power: true, thermo_mac: 'DE:MO:00:00:00:01', poll_ms: 60000, monitor_secs: 180 }; }

export function getDemoCommands(sn = DEMO_SN): RelayCommand[] {
  return [{ id: -1, device_sn: sn, command: 'demo-status', payload: { demo: true }, status: 'done', attempts: 1, result: { output: '演示模式：未执行真实设备操作' }, error: null, issued_by: 'demo', created_at: isoNow(), dispatched_at: isoNow(), executed_at: isoNow(), expires_at: null }];
}

export function getDemoWeather(): AmapWeather { return { city: '北京', adcode: '110101', reportTime: isoNow(), today: { dayWeather: '晴', nightWeather: '晴', dayTemp: 29, nightTemp: 21 }, casts: [{ date: isoNow().slice(0, 10), dayWeather: '晴', nightWeather: '晴', dayTemp: 29, nightTemp: 21 }] }; }

export function getDemoCameraDevices(): any[] { return [{ deviceSerial: 'DEMO-CAMERA', deviceName: '演示监控', status: 1, battery: 94, demo: true }]; }

export function getDemoAlarms(): AlarmItem[] { return Array.from({ length: 4 }, (_, i) => ({ id: `demo-alarm-${i}`, time: new Date(Date.now() - i * 86400000 - 3600000).toISOString().slice(0, 16).replace('T', ' '), type: i % 2 ? '10110' : '10120', picUrl: '', title: '演示告警', description: '演示模式本地告警记录', deviceSerial: 'DEMO-CAMERA' })); }

export function getDemoWidgetPayload(): Record<string, string | number | boolean> {
  const now = Date.now();
  return { widget_battery_pct: 82, widget_soc_voltage: 82, widget_soc_source: 'bms',
    widget_voltage: demoBatteryFixture.packVoltageV, widget_temperature: demoBatteryFixture.highestTempC,
    widget_range_calibrated: 106.8, widget_charging: false, widget_vehicle_name: '演示车辆',
    widget_health_score: demoBatteryFixture.healthPct, widget_locked: 1,
    widget_tpms_front_bar: 2.26, widget_tpms_front_temp_c: 29, widget_tpms_front_at: now,
    widget_tpms_rear_bar: 2.31, widget_tpms_rear_temp_c: 31, widget_tpms_rear_at: now,
    widget_location_short: '北京·演示位置', widget_charge_power_w: 0,
    widget_cycles: demoBatteryFixture.cycles, widget_updated_at: now, widget_telemetry_at: now,
    widget_demo_label: 'DEMO' };
}
