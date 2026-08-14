<?php

namespace App\Services\Dashboard;

use App\Models\BmsLiveSnapshot;
use Illuminate\Support\Carbon;

/**
 * Fetches the freshest relay-streamed ANT board frame for a device.
 *
 * The relay streams board frames ~every 2.1s while attached, so a frame
 * within RELAY_BOARD_FRESH_SEC means "real-time board telemetry available
 * right now". Used by the dashboard to prefer the relay's measured
 * current/power/voltage/SOC over estimates, and to surface the board's
 * coulomb-counted SOC (soc_pct, ∫I·dt) as the primary battery ring口径.
 */
class RelayLiveBmsService
{
    private const RELAY_BOARD_FRESH_SEC = 60;
    /**
     * A coulomb-counted BMS value does not become wrong just because the
     * transport missed one minute. Keep it as the primary display source for
     * five minutes, while exposing `fresh` separately so real-time screens can
     * still distinguish it from a live frame.
     */
    private const DISPLAY_BMS_USABLE_SEC = 300;

    /**
     * @return array{
     *     fresh: bool,
     *     age_seconds: int,
     *     total_voltage_v: ?float,
     *     current_a: ?float,
     *     power_w: ?float,
     *     soc_pct: ?float,
     *     soh_pct: ?float,
     *     capacity_total_ah: ?float,
     *     capacity_remaining_ah: ?float,
     *     cycle_capacity_ah: ?float,
     *     runtime_seconds: ?int,
     *     cell_count: ?int,
     *     cells_mv: ?array,
     *     temps_c: ?array,
     *     crc_ok: ?bool
     * }|null
     */
    public static function current(string $sn): ?array
    {
        // crc_ok = 1 is mandatory: a frame that failed CRC carries garbage in
        // every field (observed: 54 V with every other column null) and, being
        // the newest row, would present itself as the live reading.
        // source = 'relay' is mandatory: the dashboard phone can also read the
        // ANT board over its own BLE and posts those frames to the same table.
        // If its own upload counted here, board_fresh would flip the dashboard's
        // "prefer the relay" arbitration on the strength of data it provided
        // itself — mislabeling it as relay data and dropping the phone's BLE in a
        // connect/freeze flap. Only dedicated-relay frames may claim "relay live".
        $frame = BmsLiveSnapshot::query()
            ->live()
            ->where('device_sn', $sn)
            ->where('source', 'relay')
            ->where('crc_ok', true)
            ->whereNotNull('total_voltage_v')
            ->orderByDesc('created_at')
            ->first();

        return self::mapFrame($frame, false);
    }

    /**
     * Latest valid board frame for the dashboard's *single* primary energy
     * reading. A direct dashboard-phone BLE read and the relay read the same
     * board, so both are valid sources here. `current()` intentionally remains
     * relay-only because relay liveness must never be faked by the dashboard
     * phone's own reading.
     *
     * @return array<string, mixed>|null
     */
    public static function currentForDisplay(string $sn): ?array
    {
        $frame = BmsLiveSnapshot::query()
            ->live()
            ->where('device_sn', $sn)
            ->whereIn('source', ['relay', 'phone'])
            ->where('crc_ok', true)
            ->whereNotNull('total_voltage_v')
            ->whereNotNull('soc_pct')
            ->orderByDesc('created_at')
            ->first();

        return self::mapFrame($frame, true);
    }

    /**
     * @return array<string, mixed>|null
     */
    private static function mapFrame(?BmsLiveSnapshot $frame, bool $forDisplay): ?array
    {

        if ($frame === null) {
            return null;
        }

        $ageSeconds = max(0, (int) $frame->created_at->diffInSeconds(Carbon::now()));

        return [
            'fresh' => $ageSeconds < self::RELAY_BOARD_FRESH_SEC,
            // Only the primary-energy path uses this longer hold window. The
            // relay diagnostic page should continue to use `fresh`.
            'usable' => $forDisplay && $ageSeconds < self::DISPLAY_BMS_USABLE_SEC,
            'age_seconds' => $ageSeconds,
            'updated_at' => $frame->created_at?->toISOString(),
            'source' => $frame->source,
            'total_voltage_v' => $frame->total_voltage_v !== null ? (float) $frame->total_voltage_v : null,
            'current_a' => $frame->current_a !== null ? (float) $frame->current_a : null,
            'battery_status' => $frame->battery_status,
            'charge_mosfet_code' => $frame->charge_mosfet_code,
            'discharge_mosfet_code' => $frame->discharge_mosfet_code,
            'balancer_code' => $frame->balancer_code,
            'power_w' => $frame->power_w !== null ? (float) $frame->power_w : null,
            'soc_pct' => $frame->soc_pct !== null ? (float) $frame->soc_pct : null,
            'soh_pct' => $frame->soh_pct !== null ? (float) $frame->soh_pct : null,
            // These are direct values reported by the protection board. Total
            // capacity is its configured capacity; remaining capacity is its
            // coulomb-counter reading, so neither is substituted with a
            // voltage-based estimate here.
            'capacity_total_ah' => $frame->capacity_total_ah !== null ? (float) $frame->capacity_total_ah : null,
            'capacity_remaining_ah' => $frame->capacity_remaining_ah !== null ? (float) $frame->capacity_remaining_ah : null,
            'cycle_capacity_ah' => $frame->cycle_capacity_ah !== null ? (float) $frame->cycle_capacity_ah : null,
            'runtime_seconds' => $frame->runtime_seconds !== null ? (int) $frame->runtime_seconds : null,
            'cell_count' => $frame->cell_count !== null ? (int) $frame->cell_count : null,
            'cells_mv' => $frame->cells_mv,
            'temps_c' => $frame->temps_c,
            'crc_ok' => $frame->crc_ok !== null ? (bool) $frame->crc_ok : null,
        ];
    }
}
