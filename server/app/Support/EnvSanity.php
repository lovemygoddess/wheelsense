<?php

namespace App\Support;

/**
 * 环境温湿度物理合理性校验。
 *
 * 与 BmsSanity 同构，但针对小米温湿度计的量程：温度 -40~85℃（电子
 * 温度计典型量程），湿度 0~100%。被 RelayBatchController.ingestEnv 复用，
 * 逻辑集中在这一处，避免两条上报路径在校验上漂移。
 */
final class EnvSanity
{
    /**
     * @param  array<string, mixed>  $d
     * @return list<string>  空数组表示有效
     */
    public static function check(array $d): array
    {
        $errs = [];

        $t = $d['temp_c'] ?? null;
        if ($t !== null && (! is_numeric($t) || (float) $t < -40 || (float) $t > 85)) {
            $errs[] = 'temp_c out of [-40,85]';
        }

        $h = $d['humidity_pct'] ?? null;
        if ($h !== null && (! is_numeric($h) || (float) $h < 0 || (float) $h > 100)) {
            $errs[] = 'humidity_pct out of [0,100]';
        }

        $mv = $d['sensor_battery_mv'] ?? null;
        if ($mv !== null && is_numeric($mv) && (int) $mv < 0) {
            $errs[] = 'sensor_battery_mv negative';
        }

        return $errs;
    }
}
