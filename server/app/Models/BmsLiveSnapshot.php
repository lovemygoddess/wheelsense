<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class BmsLiveSnapshot extends Model
{
    protected $table = 'bms_live_snapshots';

    protected $fillable = [
        'device_sn',
        'cell_count',
        'cells_mv',
        'total_voltage_v',
        'current_a',
        'battery_status',
        'charge_mosfet_code',
        'discharge_mosfet_code',
        'balancer_code',
        'soc_pct',
        'soh_pct',
        'capacity_total_ah',
        'capacity_remaining_ah',
        'power_w',
        'temps_c',
        'runtime_seconds',
        'crc_ok',
        'frame_hex',
        'parse_error',
        'ninebot_voltage_v',
        'ninebot_soc_pct',
        'voltage_diff_v',
        'soc_diff_pct',
        'captured_at',
        'phone_battery_level_pct',
        'phone_battery_temp_c',
        'phone_charging',
        'phone_battery_voltage_v',
        'phone_screen_on',
        'board_connected',
        'is_heartbeat',
        'ble_state',
        'ble_status',
        'app_ver',
        // Offline relay additions
        'is_backfill',
        'gps_only',
        'clock_disciplined',
        'riding',
        'cycle_capacity_ah',
        'gps_lat',
        'gps_lon',
        'gps_speed_mps',
        'gps_accuracy_m',
        'gps_altitude_m',
        'gps_bearing_deg',
        'pending_rows',
        'source',
    ];

    protected $casts = [
        'cells_mv' => 'array',
        'temps_c' => 'array',
        'captured_at' => 'datetime',
        'crc_ok' => 'boolean',
        'board_connected' => 'boolean',
        'is_heartbeat' => 'boolean',
        'phone_screen_on' => 'boolean',
        'ble_state' => 'string',
        'is_backfill' => 'boolean',
        'gps_only' => 'boolean',
        'clock_disciplined' => 'boolean',
        'riding' => 'boolean',
        'cycle_capacity_ah' => 'float',
        'gps_lat' => 'float',
        'gps_lon' => 'float',
        'gps_speed_mps' => 'float',
        'gps_accuracy_m' => 'float',
        'gps_altitude_m' => 'float',
        'gps_bearing_deg' => 'float',
        'battery_status' => 'integer',
        'charge_mosfet_code' => 'integer',
        'discharge_mosfet_code' => 'integer',
        'balancer_code' => 'integer',
    ];

    /**
     * Rows that describe the relay's CURRENT state.
     *
     * A backfilled row is written with created_at = now() but describes a
     * moment that may be days old, so anything measuring "is the relay alive"
     * must exclude it or a single flush will fake an online relay for the
     * next five minutes.
     */
    public function scopeLive($query)
    {
        return $query->where('is_backfill', false);
    }
}
