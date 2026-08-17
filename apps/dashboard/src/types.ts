export interface Account {
  username: string;
  avatar: string;
  phone: string;
}

export interface Vehicle {
  sn: string;
  name: string;
  model: string;
  color: string | null;
  vehicle_name_zh: string | null;
  image_url: string | null;
  custom_image_url: string | null;
  latest: Snapshot | null;
  effective_cycle_count: number | null;
  total_mileage_km: number | null;
}

/**
 * Server-selected primary energy reading. This is the only SOC/range pair a
 * normal screen or widget should display; alternative raw values live under
 * diagnostics for troubleshooting only.
 */
export interface PrimaryTelemetry {
  soc_pct: number | null;
  range_km: number | null;
  source: 'bms' | 'voltage' | 'vendor' | 'unavailable';
  source_detail: 'relay' | 'phone' | null;
  updated_at: string | null;
  age_seconds: number | null;
  fresh: boolean;
  quality: 'live' | 'cached' | 'estimated' | 'reference_only' | 'unavailable';
  confidence: number;
  degraded_reason: string | null;
  usable_for_range: boolean;
  usable_for_safety: boolean;
  diagnostics: {
    bms_soc_pct: number | null;
    bms_age_seconds: number | null;
    bms_fresh: boolean;
    bms_usable: boolean;
    bms_source: 'relay' | 'phone' | null;
    voltage_soc_pct: number | null;
    learned_soc_pct: number | null;
    vendor_soc_pct: number | null;
    range_wh_per_km: number | null;
    range_confidence: number | null;
    range_note: string | null;
  };
}

export interface Snapshot {
  timestamp: string;
  battery: number | null;
  endurance: number | null;
  ai_estimate_mileage: number | null;
  precise_estimate_mileage: number | null;
  charging: boolean;
  power: number | null;
  lock: number | null;
  bms_voltage: number | null;
  batt_temp: number | null;
  bms_cycles: number | null;
  bms_score: number | null;
  charging_power: number | null;
  /** Canonical SOC/range contract returned by the server. */
  primary?: PrimaryTelemetry;
  /** 自学习续航（km）：电压法 SOC × 容量 × 自学习 wh_per_km，随校准持续变准。
   *  null = 未校准或电压缺失，应回退 vendor endurance。 */
  calibrated_endurance_km?: number | null;
  /** 电压法 SOC%（蜂巢 14S 高压 OCV 表，pack电压÷14串）——回退口径；
   *  vendor dump_energy 按原厂电池标定，在此包上系统性偏高。 */
  soc_voltage_pct?: number | null;
  /** 保护板库仑 SOC%（relay 实时帧 soc_pct，∫I·dt 真实计量）——最优主口径。
   *  仅 relay 实时帧可用（fresh）时非 null；为 null 时回退 soc_voltage_pct。 */
  bms_soc_pct?: number | null;
  /** 当前电量环主口径：'bms'（保护板实时）或 'voltage'（电压法回退）。 */
  soc_source?: 'bms' | 'voltage' | 'vendor' | 'unavailable' | null;
  /** 学习曲线 SOC%（参照用，曲线在高电压区可能饱和）。 */
  soc_calibrated_pct?: number | null;
  /** upstream passthrough — numeric minutes on most firmware, string on some */
  remain_charge_time: number | string | null;
  location: { latitude: number; longitude: number; description: string | null } | null;
  /** Bearer token for the home-screen widget's self-refresh endpoint
   *  (/api/widget/summary). Only present on session-gated responses. */
  widget_token?: string | null;
}

/** Live board telemetry reported by the relay (a real ANT frame). */
export interface RelayBmsFrame {
  /** Whether a board frame arrived within the freshness window (live now). */
  fresh: boolean;
  age_seconds: number;
  total_voltage_v: number | null;
  current_a: number | null;
  battery_status: number | null;
  charge_mosfet_code: number | null;
  discharge_mosfet_code: number | null;
  balancer_code: number | null;
  power_w: number | null;
  soc_pct: number | null;
  soh_pct: number | null;
  /** Protection-board configured capacity, not a learned-capacity estimate. */
  capacity_total_ah: number | null;
  /** Protection-board coulomb-counter remaining capacity. */
  capacity_remaining_ah: number | null;
  /** Board-reported accumulated capacity; semantics depend on board firmware. */
  cycle_capacity_ah: number | null;
  runtime_seconds: number | null;
  cell_count: number | null;
  cells_mv: number[] | null;
  temps_c: number[] | null;
  crc_ok: boolean | null;
}

/** 小米米家蓝牙温湿度计 2（pvvx 固件，0x181A 广播）最近一次读数。
 *  由 S7 中继被动扫描 → /api/relay/batch → env_samples。
 *  注意：这是「车库/尾箱环境」温湿度，与电池温度、手机温度完全无关。 */
export interface AmbientReading {
  /** 环境温度 °C（传感器 ±0.1℃）。 */
  temp_c: number | null;
  /** 相对湿度 %。 */
  humidity_pct: number | null;
  /** 温湿度计自身纽扣电池电压（mV，CR2032 满电≈3000）。 */
  sensor_battery_mv: number | null;
  /** 中继收到广播时的信号强度 dBm（判断距离/遮挡）。 */
  rssi: number | null;
  /** 5 分钟内有新读数 = 传感器与中继都活着。 */
  fresh: boolean;
  age_seconds: number | null;
  captured_at: string | null;
}

/** BMS relay phone's own status, surfaced on the dashboard.
 *  Sourced from the latest bms_live_snapshots row the relay APK posted. */
export interface RelayStatus {
  /** Whether any relay row exists for this device (relay ever ran + reported). */
  present: boolean;
  device_sn: string;
  /** Relay phone reported within the last 5 min (reachable). */
  connected: boolean;
  /** Latest row carried a real BMS frame (ANT board was attached). */
  board_connected: boolean;
  /** A real BMS frame arrived within the freshness window (live telemetry now). */
  board_fresh: boolean;
  /** Canonical relationship between relay, board link and server telemetry. */
  board_state: 'live' | 'connected_stale' | 'disconnected' | 'relay_offline' | 'unavailable';
  /** Age of the latest valid relay board frame, independent of phone heartbeat. */
  board_frame_age_seconds: number | null;
  /** Age of the heartbeat that observed the physical BLE board link. */
  board_link_age_seconds: number | null;
  /** 中继 BLE 链路状态文案（来自 S7 心跳）：如「扫描中…」/「未发现设备」/「蓝牙权限不足」/「已连接 xxx」。null=未知。 */
  ble_status: string | null;
  /** Latest live board telemetry from the relay, or null if never reported. */
  bms: RelayBmsFrame | null;
  phone_battery_level_pct: number | null;
  phone_battery_temp_c: number | null;
  phone_charging: boolean | null;
  phone_battery_voltage_v: number | null;
  /** 中继手机亮屏状态（PowerManager.isInteractive，Android 8 PARTIAL_WAKE_LOCK 下熄屏也正常）。null=未知。 */
  phone_screen_on: boolean | null;
  /** ISO timestamp of the latest report. */
  last_report_at: string | null;
  /** Seconds since the latest report. */
  age_seconds: number | null;
  /** 中继拉取命令/配置的间隔（ms）；遥测上报频率由服务端动态控制。 */
  poll_ms: number;
  /** 中继旁边的米家温湿度计最近读数（从未上报过 → null）。 */
  ambient: AmbientReading | null;
  /** 中继 APK 当前版本号（来自 S7 心跳上报的 app_ver）；中继从未上报过 → null。 */
  app_ver: string | null;
  /** versionCode from the heartbeat or a server-side official release map. */
  version_code: number | null;
  /** heartbeat | release_map | unknown. Unknown never implies an update. */
  version_code_source?: 'heartbeat' | 'release_map' | 'unknown' | string;
}

export interface RelayApkInfo {
  exists: boolean;
  latest_version_name: string | null;
  latest_version_code: number | null;
  size?: number | null;
  published_at?: string | null;
  sha256?: string | null;
  release_notes?: string | null;
}

/** 下发给中继手机的远控指令（当前仅拍照）。 */
export interface RelayCommand {
  id: number;
  device_sn: string;
  command: string;
  payload: Record<string, unknown> | null;
  /** pending=待拉取 · dispatched=中继已取走 · done=执行完 · failed=失败 */
  status: 'pending' | 'dispatched' | 'done' | 'failed' | 'expired' | string;
  attempts: number;
  /** 拍照/截图成功后含 { photo_url }；shell 等命令回显在 { output }。 */
  result: { photo_url?: string; output?: string; [k: string]: unknown } | null;
  error: string | null;
  issued_by: string | null;
  created_at: string | null;
  dispatched_at: string | null;
  executed_at: string | null;
  expires_at: string | null;
}

/**
 * 中继手机（车尾箱）的远程配置，按设备保存在后端。
 * idle_ms 为停车记录/上传门控（保护板 BLE 始终 <=30s 保活），ride_ms 为骑行采样间隔。
 * poll_ms 为停车拉命令/配置间隔；骑行时中继自动限制为最多 15s。
 * monitor_secs 为停车后保持骑行频率采样的秒数（监测时长 / ride-linger）。
 * 中继离线优先，保存后等它下次轮询才生效。
 */
export interface RelayConfigData {
  device_sn: string | null;
  idle_ms: number;
  ride_ms: number;
  low_power: boolean;
  thermo_mac: string | null;
  poll_ms: number;
  monitor_secs: number;
}

/** setRelayConfig 的入参：字段均可单独设置，想恢复默认就传 null。 */
export interface RelayConfigInput {
  idle_ms?: number | null;
  ride_ms?: number | null;
  low_power?: boolean;
  thermo_mac?: string | null;
  poll_ms?: number | null;
  monitor_secs?: number | null;
}

export interface Ride {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  mileage: number;
  energy: number | null;
  energy_source?: 'bms_interval' | 'relay_voltage' | 'snapshot_voltage' | 'trusted_average' | null;
  energy_coverage?: number;
  wh_per_km?: number | null;
  avg_speed_kph: number | null;
  max_speed_kph: number | null;
}

export interface RidesMeta {
  month: string;
  month_mileage: number;
  month_energy: number | null;
  month_duration: number;
  month_ride_count: number;
  month_daily?: number[] | null;
  /** 自学习能耗（Wh/km）。上游 month_energy 按原厂标准电芯标定，与实际
   *  高压电芯有系统偏差；此值由后端持续校准，是首选口径。null = 样本不足。 */
  wh_per_km_learned?: number | null;
  wh_per_km_learned_samples?: number;
  wh_per_km_source?: 'bms_measured' | 'voltage_model' | null;
}

export interface RidesResponse {
  rides: Ride[];
  meta: RidesMeta;
}

export interface SpeedPoint {
  t: number;
  v: number;
}

export interface SpeedPeak {
  t: number;
  v: number;
}

export interface TrailSpeedAnalysis {
  ride_id: string;
  point_count: number;
  duration_sec: number;
  speed_series: SpeedPoint[];
  top_speed_kph: number | null;
  top_speed_method: string | null;
  top_speed_peaks: SpeedPeak[];
  top_speed_note: string | null;
}

export interface RangeEstimate {
  effective_endurance_km: number | null;
  calibrated_soc_pct: number | null;
  /** 电压法 SOC%（主口径） */
  soc_voltage_pct?: number | null;
  bms_soc_pct?: number | null;
  soc_source?: 'bms' | 'voltage' | 'vendor' | 'unavailable' | null;
  vendor_soc_pct: number | null;
  wh_per_km: number | null;
  confidence: number;
  note: string | null;
}

export interface ChargeTimeEstimate {
  supported: boolean;
  reason?: string;
  method?: 'bms_capacity' | 'energy' | 'power_law';
  remaining_min?: number;
  elapsed_min?: number;
  predicted_total_min?: number;
  current_voltage?: number;
  bms_full_charge_voltage?: number;
  training_events?: number;
  training_samples?: number;
  fit_p?: number;
  fit_K?: number;
  confidence?: number;
  soc_used?: number;
  soc_source?: 'bms_capacity' | 'bms_soc' | 'voltage_soc' | 'curve_under_charge_inflated';
  capacity_total_ah?: number;
  capacity_remaining_ah?: number;
  capacity_to_fill_ah?: number;
  charge_current_a?: number;
  charge_power_w?: number;
  cv_factor?: number;
  note?: string | null;
}

export interface ChargeEventRow {
  id: number;
  started_at: string | null;
  ended_at: string | null;
  start_voltage: number | null;
  end_voltage: number | null;
  peak_voltage: number | null;
  avg_temp: number | null;
  is_full_charge: boolean;
  detection_method: string | null;
}

export interface VoltageSeriesPoint {
  timestamp: string;
  voltage: number | null;
  charging: boolean;
  temp: number | null;
}

export interface CalibrationRow {
  is_calibrated: boolean;
  capacity_wh_estimate: number | null;
  wh_per_km_current: number | null;
  wh_per_km_slope: number | null;
  soc_curve_version: number;
  total_calibration_samples: number;
  confidence_soc: number;
  confidence_consumption: number;
  last_calibrated_at: string | null;
  chemistry_type: string | null;
  cell_series_count: number | null;
  bms_full_charge_voltage: number | null;
  bms_cutoff_voltage: number | null;
  nominal_voltage: number | null;
  nominal_capacity_ah: number | null;
  capacity_tolerance_pct: number | null;
  priors_updated_at: string | null;
  historical_max_speed_kph: number | null;
  effective_cycle_count: number | null;
  total_discharge_wh: number | null;
}

export interface BatteryOverview {
  device: { sn: string; name: string; model: string };
  latest: Snapshot | null;
  latest_at: string | null;
  /** Same object as Snapshot.primary and widget.summary.primary. */
  primary: PrimaryTelemetry;
  is_charging: boolean;
  range_estimate: RangeEstimate;
  charge_time_estimate: ChargeTimeEstimate;
  charge_power_w: number | null;
  ant_bms_displayed_power_w: number | null;
  charge_power_deviation_pct: number | null;
  ant_bms_measured_current_a: number | null;
  charge_current_effective_a: number | null;
  charge_current_deviation_pct: number | null;
  /** Live board telemetry from the relay, or null if not available. */
  relay: RelayBmsFrame | null;
  /** Where the displayed charge current/power come from: 'relay_live' (real
   *  board measurement) or 'estimate' (computed, no live relay data). */
  charge_source: 'relay_live' | 'estimate';
  charge_events: ChargeEventRow[];
  calibration: CalibrationRow | null;
  voltage_series: VoltageSeriesPoint[];
  window_hours: number;
  generated_at: string;
}

export interface AuthStatus {
  unlocked: boolean;
  has_password: boolean;
}

export interface SettingsPayload {
  device_sn: string;
  readonly: {
    chemistry_type: string | null;
    cell_series_count: number | null;
  };
  priors: {
    bms_full_charge_voltage: number | null;
    bms_cutoff_voltage: number | null;
    max_charge_current_a: number | null;
    charger_output_current_a: number | null;
    ant_bms_displayed_power_w: number | null;
    ant_bms_measured_current_a: number | null;
    nominal_voltage: number | null;
    nominal_capacity_ah: number | null;
    capacity_tolerance_pct: number | null;
  };
  thresholds: Record<string, number>;
  priors_set_at: string | null;
  wh_per_km_current: number | null;
  total_calibration_samples: number;
  cycle_count_baseline: number | null;
  cycle_count_baseline_wh: number | null;
  odometer_baseline_km: number | null;
  odometer_baseline_ride_km: number | null;
}
