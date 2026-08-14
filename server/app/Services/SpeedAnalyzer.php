<?php

namespace App\Services;

/**
 * Parses a Ninebot trail string into a speed time-series and analyses it
 * for the "multi-peak same-height" top-speed pattern.
 *
 * Trail format:  "lng,lat,col3,col4;lng,lat,col3,col4;..."
 *  - Column 3 is the distance (metres) between consecutive GPS samples.
 *  - Column 4 is the instantaneous signed speed in **mph** (miles per hour).
 *    Integrators should verify this unit contract against their own upstream.
 *
 * Top-speed detection — "ceiling clustering" approach:
 *  A real speed ceiling repeats — the vehicle
 *  repeatedly accelerates to a ceiling and falls back. Noise appears
 *  once; the ceiling appears many times.
 *  Instead of fragile peak detection (which fails when the speed
 *  oscillates rapidly at the limit with shallow valleys), we:
 *    1. Take all valid speed values (km/h, after mph conversion).
 *    2. Find the max — this is the candidate ceiling.
 *    3. Count how many points fall within ±5 km/h of that max.
 *    4. If ≥5 points cluster there, the ceiling is real →
 *       top_speed = their mean (more robust than any single point).
 *    5. If <5 points, the "high" was a one-off (noise or a brief
 *       burst) → no stable pattern, return null.
 */
class SpeedAnalyzer
{
    /** Conversion factor: 1 mph → km/h. */
    private const MPH_TO_KMH = 1.60934;

    /** Physical speed cap for this vehicle type (km/h, AFTER conversion). */
    private const MAX_PHYSICAL_SPEED = 95.0;

    /** Points to discard from each end (GPS lock/unlock transients). */
    private const BOUNDARY_DISCARD = 2;

    /**
     * Two speeds are "same height" if they fall within ±WINDOW km/h
     * of each other.
     */
    private const CLUSTER_WINDOW = 5.0;

    /**
     * Minimum number of points in the high-speed cluster to confirm
     * a real speed limit (vs. single-point noise).
     */
    private const MIN_CLUSTER_POINTS = 5;

    /**
     * Smoothing window for the display curve (odd number).
     */
    private const SMOOTH_WINDOW = 3;

    /**
     * Analyse a trail string end-to-end.
     *
     * @param  string  $trail  Raw trail field from /travel/{id}.
     * @param  float|null  $apiAvgSpeed  Upstream `speed` (ride average, km/h) for fallback.
     * @return array{
     *     point_count: int,
     *     duration_sec: float,
     *     speed_series: list<array{t: float, v: float}>,
     *     top_speed_kph: float|null,
     *     top_speed_method: string|null,
     *     top_speed_peaks: list<array{t: float, v: float}>,
     *     top_speed_note: string|null
     * }
     */
    public function analyse(string $trail, ?float $apiAvgSpeed = null, ?float $mileage = null): array
    {
        // Dynamic speed cap: short rides have more GPS noise, so use
        // a tighter physical limit based on ride distance.
        $speedCap = self::MAX_PHYSICAL_SPEED;
        if ($mileage !== null) {
            if ($mileage < 2.0) $speedCap = 50.0;
            elseif ($mileage < 5.0) $speedCap = 85.0;
        }

        $series = $this->parseTrail($trail, $speedCap);

        // Empty trail (no data at all) → fallback to API average.
        if (empty($series) && $trail === '') {
            return [
                'point_count' => 0,
                'duration_sec' => 0.0,
                'speed_series' => [],
                'top_speed_kph' => $apiAvgSpeed !== null && $apiAvgSpeed > 0
                    ? min($apiAvgSpeed, self::MAX_PHYSICAL_SPEED) : null,
                'top_speed_method' => $apiAvgSpeed !== null && $apiAvgSpeed > 0 ? 'api_avg_fallback' : null,
                'top_speed_peaks' => [],
                'top_speed_note' => '无轨迹数据',
            ];
        }

        // Check GPS data quality: count raw points before filtering
        $rawCount = substr_count($trail, ';') + 1;
        $validRatio = $rawCount > 0 ? count($series) / $rawCount : 0;

        // If most points were filtered as implausible, the GPS data is
        // unreliable — don't show a misleading curve.
        if (count($series) < 3 || ($rawCount > 5 && $validRatio < 0.3)) {
            return [
                'point_count' => count($series),
                'duration_sec' => 0.0,
                'speed_series' => [],
                'top_speed_kph' => null,
                'top_speed_method' => 'gps_unreliable',
                'top_speed_peaks' => [],
                'top_speed_note' => 'GPS 数据不可信（短途骑行定位漂移）',
            ];
        }

        $duration = end($series)['t'];

        // Smooth for display (also used for peak marking).
        $smoothed = $this->movingAverage(
            array_map(fn (array $p) => $p['v'], $series),
            self::SMOOTH_WINDOW,
        );
        $times = array_map(fn (array $p) => $p['t'], $series);

        // --- Ceiling clustering ---
        $speeds = array_map(fn (array $p) => $p['v'], $series);

        // Scan from the highest speed downward to find the first ceiling
        // with ≥MIN_CLUSTER_POINTS within ±CLUSTER_WINDOW. This handles
        // GPS noise spikes (single points above the real riding ceiling)
        // without missing the true multi-peak pattern.
        $ceilingSpeed = null;
        $clusterIdx = [];
        $clusterVals = [];
        $uniqueSpeeds = array_unique($speeds);
        rsort($uniqueSpeeds);

        foreach ($uniqueSpeeds as $candidate) {
            $idx = [];
            $vals = [];
            foreach ($speeds as $i => $v) {
                if (abs($v - $candidate) <= self::CLUSTER_WINDOW) {
                    $idx[] = $i;
                    $vals[] = $v;
                }
            }
            if (count($vals) >= self::MIN_CLUSTER_POINTS) {
                $ceilingSpeed = $candidate;
                $clusterIdx = $idx;
                $clusterVals = $vals;
                break;
            }
        }

        $topSpeed = null;
        $method = null;
        $peakNotes = null;
        $matchedPeaks = [];

        if ($ceilingSpeed !== null) {
            // Real ceiling confirmed — take the mean for robustness.
            $topSpeed = round(array_sum($clusterVals) / count($clusterVals), 1);
            $method = 'multi_peak';

            // Mark the highest points as "peaks" for the chart.
            // Take up to 8 representative points from the cluster,
            // spread across the ride timeline.
            $matchedPeaks = $this->selectRepresentativePeaks(
                $clusterIdx,
                $smoothed,
                $times,
            );
        }

        if ($topSpeed === null && $apiAvgSpeed !== null && $apiAvgSpeed > 0) {
            $topSpeed = min($apiAvgSpeed, self::MAX_PHYSICAL_SPEED);
            $method = 'api_avg_fallback';
            $peakNotes = '未达到稳定高速区间';
        } elseif ($topSpeed === null) {
            $method = 'no_stable_high_speed';
            $peakNotes = '未达到稳定高速区间';
        }

        return [
            'point_count' => count($series),
            'duration_sec' => round($duration, 1),
            'speed_series' => $series,
            'top_speed_kph' => $topSpeed,
            'top_speed_method' => $method,
            'top_speed_peaks' => $matchedPeaks,
            'top_speed_note' => $peakNotes,
        ];
    }

    /**
     * Convenience: extract just the top speed (for backfill command).
     */
    public function extractTopSpeed(string $trail, ?float $apiAvgSpeed = null): ?float
    {
        return $this->analyse($trail, $apiAvgSpeed)['top_speed_kph'];
    }

    // ------------------------------------------------------------------
    //  Trail parsing
    // ------------------------------------------------------------------

    /**
     * Parse the raw trail string into a speed time-series.
     *
     * The trail's col4 is in **mph** — we convert to km/h here so the
     * rest of the pipeline operates entirely in km/h.
     *
     * GPS noise filtering:
     *  1. Discard first/last BOUNDARY_DISCARD points (GPS lock transients).
     *  2. Skip points with col3 ≤ 0 and speed > 0 (GPS jumps with
     *     zero distance but a spurious speed reading).
     *  3. Filter speeds above MAX_PHYSICAL_SPEED (after mph→km/h).
     *  4. Clamp small negatives to 0.
     *
     * Time estimation: col3 is distance (metres) between samples.
     * We derive elapsed seconds from distance / speed(m/s).
     *
     * @return list<array{t: float, v: float}>  Cumulative seconds + speed (km/h).
     */
    private function parseTrail(string $trail, float $speedCap = self::MAX_PHYSICAL_SPEED): array
    {
        $points = explode(';', $trail);
        $count = count($points);
        $series = [];
        $cumT = 0.0;

        foreach ($points as $i => $point) {
            $parts = explode(',', $point);
            if (count($parts) < 4) {
                continue;
            }

            $col3 = (float) $parts[2];   // distance between samples (metres)
            $vMph = (float) $parts[3];    // instantaneous speed (mph, signed)

            // Estimate elapsed seconds from distance / speed.
            if ($col3 > 0 && $vMph > 0) {
                $speedMs = $vMph * 0.44704;  // mph → m/s
                $cumT += $col3 / $speedMs;
            } elseif ($col3 > 0) {
                $cumT += $col3 / 5.0;
            }

            // Discard boundary transients (GPS lock/unlock noise).
            if ($i < self::BOUNDARY_DISCARD || $i >= $count - self::BOUNDARY_DISCARD) {
                continue;
            }

            // Skip GPS jump points: zero distance with speed = noise.
            if ($col3 <= 0 && $vMph > 0) {
                continue;
            }

            // Convert mph → km/h.
            $v = $vMph * self::MPH_TO_KMH;

            // Filter physically impossible values (dynamic cap based on ride distance).
            if ($v > $speedCap) {
                continue;
            }

            // Clamp small negatives to 0.
            if ($v < 0) {
                $v = 0.0;
            }

            $series[] = ['t' => round($cumT, 1), 'v' => round($v, 1)];
        }

        return $series;
    }

    // ------------------------------------------------------------------
    //  Utilities
    // ------------------------------------------------------------------

    /**
     * Simple centred moving average.
     *
     * @param  list<float>  $values
     * @return list<float>
     */
    private function movingAverage(array $values, int $window): array
    {
        $n = count($values);
        if ($n === 0 || $window <= 1) {
            return $values;
        }

        $half = intdiv($window, 2);
        $result = [];

        for ($i = 0; $i < $n; $i++) {
            $sum = 0.0;
            $cnt = 0;
            for ($j = max(0, $i - $half); $j <= min($n - 1, $i + $half); $j++) {
                $sum += $values[$j];
                $cnt++;
            }
            $result[] = $sum / $cnt;
        }

        return $result;
    }

    /**
     * Select up to 8 representative peak points from the cluster,
     * spread across the ride timeline for chart marking.
     *
     * @param  list<int>  $clusterIdx  Indices into the series array.
     * @param  list<float>  $smoothed
     * @param  list<float>  $times
     * @return list<array{t: float, v: float}>
     */
    private function selectRepresentativePeaks(array $clusterIdx, array $smoothed, array $times): array
    {
        if (empty($clusterIdx)) {
            return [];
        }

        // Sort by index to keep timeline order.
        sort($clusterIdx);

        // Pick at most 8, evenly spaced across the cluster.
        $total = count($clusterIdx);
        $maxPeaks = 8;
        $step = max(1, intdiv($total, $maxPeaks));

        $peaks = [];
        foreach ($clusterIdx as $k => $idx) {
            if ($k % $step !== 0 && $k !== $total - 1) {
                continue;
            }
            $peaks[] = [
                't' => $times[$idx] ?? 0.0,
                'v' => round($smoothed[$idx] ?? 0.0, 1),
            ];
        }

        return $peaks;
    }
}
