<?php

namespace App\Services\Dashboard;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;

/** Prevents source changes and noisy samples from making displayed SOC jump. */
class SocStabilizer
{
    private const TTL_SECONDS = 172800;

    /**
     * @return array{soc:float,source:string,held:bool,raw_soc:float,raw_source:string}
     */
    public function stabilize(
        string $deviceSn,
        float $candidateSoc,
        string $candidateSource,
        bool $charging,
        bool $resting,
        ?Carbon $sampleAt = null,
    ): array {
        $key = "dashboard:soc_state:$deviceSn";
        // The filter must advance with telemetry, never with GET frequency.
        // Home, Battery and the widget often request the same snapshot within
        // seconds; treating those reads as new samples made each page show a
        // different SOC from the exact same source row.
        $now = $sampleAt?->getTimestamp() ?? time();
        $state = Cache::get($key);
        $candidateSoc = max(0.0, min(100.0, $candidateSoc));
        $rawSoc = $candidateSoc;
        $rawSource = $candidateSource;

        if (! is_array($state) || ! isset($state['soc'], $state['source'], $state['at'])) {
            $state = ['soc' => $candidateSoc, 'source' => $candidateSource, 'at' => $now];
            Cache::put($key, $state, self::TTL_SECONDS);
            return ['soc' => round($candidateSoc, 1), 'source' => $candidateSource, 'held' => false, 'raw_soc' => $candidateSoc, 'raw_source' => $candidateSource];
        }

        $oldSoc = (float) $state['soc'];
        $oldSource = (string) $state['source'];
        if ($now <= (int) $state['at']) {
            return [
                'soc' => round($oldSoc, 1),
                'source' => $oldSource,
                'held' => $candidateSource !== $oldSource,
                'raw_soc' => round($rawSoc, 1),
                'raw_source' => $rawSource,
            ];
        }
        $dt = max(1, $now - (int) $state['at']);
        $held = false;

        // A long telemetry gap means the previous state is no longer a useful
        // continuity constraint. Accept the current physical reading instead
        // of spending hours crawling from an obsolete value.
        if ($dt >= 600) {
            $state = ['soc' => $candidateSoc, 'source' => $candidateSource, 'at' => $now];
            Cache::put($key, $state, self::TTL_SECONDS);
            return ['soc' => round($candidateSoc, 1), 'source' => $candidateSource, 'held' => false, 'raw_soc' => round($rawSoc, 1), 'raw_source' => $rawSource];
        }

        if ($candidateSource !== $oldSource) {
            $pendingSource = $state['pending_source'] ?? null;
            $pendingSince = (int) ($state['pending_since'] ?? $now);
            if ($pendingSource !== $candidateSource) {
                $pendingSource = $candidateSource;
                $pendingSince = $now;
            }
            // BMS recovery is accepted quickly; falling back from a recent BMS
            // reading requires a full minute of consistent alternative data.
            $required = $candidateSource === 'bms' ? 5 : 60;
            if ($now - $pendingSince < $required) {
                $candidateSoc = $oldSoc;
                $candidateSource = $oldSource;
                $held = true;
                $state['pending_source'] = $pendingSource;
                $state['pending_since'] = $pendingSince;
            } else {
                unset($state['pending_source'], $state['pending_since']);
            }
        } else {
            unset($state['pending_source'], $state['pending_since']);
        }

        // Allow realistic high-load discharge, but reject impossible jumps.
        $maxDelta = max(0.8, min(8.0, $dt / 60.0 * 2.5));
        $upper = $charging ? $oldSoc + $maxDelta : $oldSoc + 0.5;
        $lower = $charging ? $oldSoc - 0.5 : $oldSoc - $maxDelta;
        $nextSoc = max($lower, min($upper, $candidateSoc));

        // Resting voltage is useful as a correction, not as a hard replacement.
        if ($resting && $candidateSource === 'voltage' && ! $held) {
            $nextSoc = $oldSoc * 0.7 + $nextSoc * 0.3;
        }
        $nextSoc = max(0.0, min(100.0, $nextSoc));

        $state['soc'] = $nextSoc;
        $state['source'] = $candidateSource;
        $state['at'] = $now;
        Cache::put($key, $state, self::TTL_SECONDS);

        return [
            'soc' => round($nextSoc, 1),
            'source' => $candidateSource,
            'held' => $held,
            'raw_soc' => round($rawSoc, 1),
            'raw_source' => $rawSource,
        ];
    }
}
