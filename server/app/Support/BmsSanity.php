<?php

namespace App\Support;

/**
 * Physical plausibility checks for a parsed ANT BMS frame.
 *
 * A frame that passes CRC can still be nonsense — a partially reassembled
 * buffer decodes cleanly into fields that are individually well-formed and
 * collectively impossible. Storing those is worse than dropping them: the
 * calibration maths treats every stored row as a measurement, so one 12 V
 * "reading" on a 14S pack drags the learned curve off for days.
 *
 * Extracted from BmsLiveSnapshotController so the batch ingestion path
 * applies exactly the same bar — a lower bar on the bulk path would be the
 * obvious way in for garbage.
 */
final class BmsSanity
{
    /** NMC safe cell window, millivolts. */
    private const CELL_MIN_MV = 2500;
    private const CELL_MAX_MV = 4500;

    /** Protection board's rated ceiling. */
    private const MAX_CURRENT_A = 200;

    /**
     * @param  array<string, mixed>  $data
     * @return list<string>  human-readable problems; empty means plausible.
     */
    public static function check(array $data): array
    {
        $errors = [];

        $cells = $data['cells_mv'] ?? null;
        $cellCount = $data['cell_count'] ?? null;

        if (is_array($cells)) {
            foreach ($cells as $i => $mv) {
                if ($mv !== null && ($mv < self::CELL_MIN_MV || $mv > self::CELL_MAX_MV)) {
                    $errors[] = "cell #{$i} voltage {$mv}mV out of range ["
                        . self::CELL_MIN_MV . ', ' . self::CELL_MAX_MV . ']';
                }
            }
        }

        $totalV = $data['total_voltage_v'] ?? null;
        if ($totalV !== null && $cellCount !== null && $cellCount > 0) {
            $minV = $cellCount * (self::CELL_MIN_MV / 1000);
            $maxV = $cellCount * (self::CELL_MAX_MV / 1000);
            if ($totalV < $minV || $totalV > $maxV) {
                $errors[] = "total_voltage {$totalV}V inconsistent with cell_count {$cellCount} (expected {$minV}–{$maxV}V)";
            }
        }

        $soc = $data['soc_pct'] ?? null;
        if ($soc !== null && ($soc < 0 || $soc > 100)) {
            $errors[] = "soc {$soc}% out of range [0, 100]";
        }

        $soh = $data['soh_pct'] ?? null;
        if ($soh !== null && ($soh < 0 || $soh > 100)) {
            $errors[] = "soh {$soh}% out of range [0, 100]";
        }

        if (is_array($cells) && $cellCount !== null && count($cells) !== $cellCount) {
            $errors[] = 'cells_mv count (' . count($cells) . ") does not match cell_count ({$cellCount})";
        }

        $current = $data['current_a'] ?? null;
        if ($current !== null && abs($current) > self::MAX_CURRENT_A) {
            $errors[] = "current {$current}A exceeds physical limit ±" . self::MAX_CURRENT_A . 'A';
        }

        return $errors;
    }
}
