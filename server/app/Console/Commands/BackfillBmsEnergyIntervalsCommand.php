<?php

namespace App\Console\Commands;

use App\Models\BmsLiveSnapshot;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class BackfillBmsEnergyIntervalsCommand extends Command
{
    protected $signature = 'bms:backfill-energy-intervals';
    protected $description = 'Backfill GPS-free BMS discharge energy intervals from stored V×I frames';

    public function handle(): int
    {
        $inserted = 0;
        $devices = BmsLiveSnapshot::query()->where('source', 'relay')->distinct()->pluck('device_sn');
        foreach ($devices as $sn) {
            $previous = null;
            BmsLiveSnapshot::query()
                ->where('device_sn', $sn)
                ->where('source', 'relay')
                ->where('crc_ok', true)
                ->where('is_heartbeat', false)
                ->whereNotNull('power_w')
                ->whereNotNull('captured_at')
                ->orderBy('captured_at')
                ->chunk(1000, function ($rows) use ($sn, &$previous, &$inserted): void {
                    $batch = [];
                    foreach ($rows as $row) {
                        if ($previous !== null) {
                            $seconds = $previous->captured_at->diffInSeconds($row->captured_at);
                            if ($seconds > 0 && $seconds <= 180) {
                                $previousPower = $previous->total_voltage_v !== null && $previous->current_a !== null
                                    ? (float) $previous->total_voltage_v * (float) $previous->current_a
                                    : (float) $previous->power_w;
                                $currentPower = $row->total_voltage_v !== null && $row->current_a !== null
                                    ? (float) $row->total_voltage_v * (float) $row->current_a
                                    : (float) $row->power_w;
                                $startW = max(0.0, -$previousPower);
                                $endW = max(0.0, -$currentPower);
                                $energy = (($startW + $endW) / 2.0) * $seconds / 3600.0;
                                if ($energy > 0.0001) {
                                    $batch[] = [
                                        'device_sn' => $sn,
                                        'started_at' => $previous->captured_at->format('Y-m-d H:i:s'),
                                        'ended_at' => $row->captured_at->format('Y-m-d H:i:s'),
                                        'energy_wh' => round($energy, 5),
                                        'duration_seconds' => $seconds,
                                        'start_power_w' => $previousPower,
                                        'end_power_w' => $currentPower,
                                        'created_at' => now(),
                                        'updated_at' => now(),
                                    ];
                                }
                            }
                        }
                        $previous = $row;
                    }
                    if ($batch !== []) {
                        $inserted += DB::table('bms_energy_intervals')->insertOrIgnore($batch);
                    }
                });
        }
        $this->info("Inserted {$inserted} BMS energy intervals");
        return self::SUCCESS;
    }
}
