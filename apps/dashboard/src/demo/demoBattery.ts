import type { BatteryOverview, CalibrationRow, ChargeEventRow, PrimaryTelemetry, RelayBmsFrame, Snapshot, VoltageSeriesPoint } from '../types';

/**
 * Battery-only Demo fixture. It is intentionally not derived from the
 * vehicle snapshot, relay cache, or any production battery store.
 */
export const demoBatteryFixture = Object.freeze({
  socPct: 82,
  packVoltageV: 56.72,
  currentA: -7.8,
  powerW: -442,
  healthPct: 96,
  highestTempC: 29.6,
  cellDeltaMv: 7,
  cycles: 83.4,
  capacityTotalAh: 92,
  capacityRemainingAh: 75.4,
  cellVoltagesMv: [4046, 4047, 4048, 4049, 4050, 4051, 4052, 4053, 4047, 4048, 4049, 4050, 4051, 4052],
  probeTempsC: [27.8, 28.4, 29.6],
  fullChargeVoltageV: 60.9,
  cutoffVoltageV: 42,
});

export function getDemoBatteryPrimary(now: number, rangeKm = 104.2): PrimaryTelemetry {
  return {
    soc_pct: demoBatteryFixture.socPct,
    range_km: rangeKm,
    source: 'bms', source_detail: 'relay', updated_at: new Date(now).toISOString(),
    age_seconds: 0, fresh: true, quality: 'live', confidence: 0.97,
    degraded_reason: null, usable_for_range: true, usable_for_safety: true,
    diagnostics: {
      bms_soc_pct: demoBatteryFixture.socPct, bms_age_seconds: 0, bms_fresh: true,
      bms_usable: true, bms_source: 'relay', voltage_soc_pct: 79.8,
      learned_soc_pct: 81.4, vendor_soc_pct: 80.9, range_wh_per_km: 19.6,
      range_confidence: 0.93, range_note: '演示电池 fixture',
    },
  };
}

export function getDemoBatterySnapshot(now = Date.now()): Snapshot {
  const primary = getDemoBatteryPrimary(now);
  return {
    timestamp: new Date(now).toISOString(), battery: demoBatteryFixture.socPct,
    endurance: primary.range_km, ai_estimate_mileage: primary.range_km,
    precise_estimate_mileage: primary.range_km, charging: false,
    power: demoBatteryFixture.powerW, lock: 1,
    bms_voltage: demoBatteryFixture.packVoltageV, batt_temp: demoBatteryFixture.highestTempC,
    bms_cycles: demoBatteryFixture.cycles, bms_score: demoBatteryFixture.healthPct,
    charging_power: null, primary, calibrated_endurance_km: primary.range_km,
    soc_voltage_pct: 79.8, bms_soc_pct: demoBatteryFixture.socPct,
    soc_source: 'bms', soc_calibrated_pct: demoBatteryFixture.socPct,
    remain_charge_time: null, location: null, widget_token: null,
  };
}

export function getDemoBatteryBms(): RelayBmsFrame {
  return {
    fresh: true, age_seconds: 0, total_voltage_v: demoBatteryFixture.packVoltageV,
    current_a: demoBatteryFixture.currentA, battery_status: 1,
    charge_mosfet_code: 0, discharge_mosfet_code: 1, balancer_code: 0,
    power_w: demoBatteryFixture.powerW, soc_pct: demoBatteryFixture.socPct,
    soh_pct: demoBatteryFixture.healthPct, capacity_total_ah: demoBatteryFixture.capacityTotalAh,
    capacity_remaining_ah: demoBatteryFixture.capacityRemainingAh,
    cycle_capacity_ah: demoBatteryFixture.cycles * demoBatteryFixture.capacityTotalAh,
    runtime_seconds: 321234, cell_count: demoBatteryFixture.cellVoltagesMv.length,
    cells_mv: [...demoBatteryFixture.cellVoltagesMv], temps_c: [...demoBatteryFixture.probeTempsC],
    crc_ok: true,
  };
}

export function getDemoBatteryCalibration(): CalibrationRow {
  return {
    is_calibrated: true, capacity_wh_estimate: 5150, wh_per_km_current: 19.6,
    wh_per_km_slope: -0.04, soc_curve_version: 3, total_calibration_samples: 42,
    confidence_soc: 0.93, confidence_consumption: 0.9,
    last_calibrated_at: new Date(Date.UTC(2025, 7, 12, 22, 10)).toISOString(),
    chemistry_type: 'Li-ion', cell_series_count: 14,
    bms_full_charge_voltage: demoBatteryFixture.fullChargeVoltageV,
    bms_cutoff_voltage: demoBatteryFixture.cutoffVoltageV, nominal_voltage: 50.4,
    nominal_capacity_ah: demoBatteryFixture.capacityTotalAh, capacity_tolerance_pct: 6,
    priors_updated_at: new Date(Date.UTC(2025, 7, 12, 22, 10)).toISOString(),
    historical_max_speed_kph: 46.8, effective_cycle_count: demoBatteryFixture.cycles,
    total_discharge_wh: 428000,
  };
}

export function getDemoVoltageSeries(hours = 24): VoltageSeriesPoint[] {
  const samples = [58.1, 57.8, 57.3, 56.9, 56.7, 56.8, 56.6, 56.5, 56.7, 56.4, 56.6, 56.5, 56.7, 56.8, 56.6, 56.9, 56.7, 56.8, 56.6, 56.7, 56.5, 56.8, 56.7, 56.72, 56.7];
  const now = Date.now();
  const spanMs = Math.max(1, hours) * 3600000;
  return samples.map((voltage, index) => ({
    timestamp: new Date(now - spanMs + (spanMs * index) / (samples.length - 1)).toISOString(),
    voltage, charging: index >= samples.length - 3, temp: 27.8 + (index % 4) * 0.6,
  }));
}

export function getDemoChargeEvents(): ChargeEventRow[] {
  const rows = [
    [12, '21:20', '23:06', 50.4, 56.7, 57.0, 28.6, true],
    [10, '20:10', '21:42', 49.8, 56.2, 56.6, 28.1, false],
    [8, '22:05', '23:38', 51.1, 56.9, 57.2, 29.0, true],
    [6, '19:30', '21:08', 48.9, 55.8, 56.3, 27.8, false],
    [4, '21:45', '23:19', 50.7, 56.5, 56.9, 28.4, true],
    [2, '20:25', '22:02', 49.5, 56.1, 56.5, 28.0, false],
  ] as const;
  const base = Date.UTC(2025, 7, 12);
  return rows.map(([daysAgo, start, end, startVoltage, endVoltage, peakVoltage, avgTemp, full], index) => {
    const day = new Date(base - daysAgo * 86400000);
    const parse = (value: string) => {
      const [hour, minute] = value.split(':').map(Number);
      return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute)).toISOString();
    };
    return {
      id: -(index + 101), started_at: parse(start), ended_at: parse(end),
      start_voltage: startVoltage, end_voltage: endVoltage, peak_voltage: peakVoltage,
      avg_temp: avgTemp, is_full_charge: full, detection_method: 'demo_battery_fixture',
    };
  });
}
