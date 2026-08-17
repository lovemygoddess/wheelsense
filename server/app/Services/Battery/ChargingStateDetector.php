<?php

namespace App\Services\Battery;

use Illuminate\Support\Carbon;

/**
 * Pure, deterministic charging classifier shared by every presentation
 * surface.  Positive BMS current is only a candidate: the candidate must be
 * stationary and remain stable long enough to distinguish a wall charger
 * from a regenerative-braking pulse.
 */
class ChargingStateDetector
{
    public const MIN_CURRENT_A = 0.6;
    public const CONFIRM_SECONDS = 45;
    public const MAX_CANDIDATE_GAP_SECONDS = 30;
    public const HOLD_SECONDS = 90;
    public const MOVING_SPEED_MPS = 0.8;
    public const MIN_SAMPLES = 3;

    /**
     * @param  list<array<string, mixed>>  $frames  Sorted or unsorted BMS frames.
     * @return array<string, mixed>
     */
    public function evaluate(array $frames, ?Carbon $now = null): array
    {
        $now ??= Carbon::now();
        usort($frames, static function (array $a, array $b): int {
            return self::at($a)->getTimestamp() <=> self::at($b)->getTimestamp();
        });

        $candidateStart = null;
        $lastQualifying = null;
        $sampleCount = 0;
        $active = false;
        $phase = 'idle';
        $rejectionReason = null;
        $lastPositiveCurrent = null;
        $lastRiding = null;
        $lastGpsSpeed = null;

        foreach ($frames as $frame) {
            $at = self::at($frame);
            $lastRiding = array_key_exists('riding', $frame) && $frame['riding'] !== null
                ? (bool) $frame['riding'] : null;
            $lastGpsSpeed = is_numeric($frame['gps_speed_mps'] ?? null)
                ? (float) $frame['gps_speed_mps'] : null;
            if (is_numeric($frame['current_a'] ?? null) && (float) $frame['current_a'] > 0) {
                $lastPositiveCurrent = (float) $frame['current_a'];
            }

            // A moving frame is a hard reset. This is deliberately stronger
            // than current hysteresis: regen can remain positive for many
            // consecutive samples while the rider is slowing down.
            if ($this->isMoving($frame)) {
                $rejectionReason = 'moving';
                if ($active) {
                    return $this->decorate(
                        $this->inactive($lastQualifying, 'movement_detected', $sampleCount),
                        'ending', $candidateStart, $lastPositiveCurrent, $lastRiding, $lastGpsSpeed, $rejectionReason,
                    );
                }
                $candidateStart = null;
                $lastQualifying = null;
                $sampleCount = 0;
                $phase = 'idle';
                continue;
            }

            if ($this->isCandidate($frame)) {
                if (! $active && $lastQualifying !== null
                    && $lastQualifying->diffInSeconds($at) > self::MAX_CANDIDATE_GAP_SECONDS
                ) {
                    $rejectionReason = 'insufficient_duration';
                    $candidateStart = null;
                    $sampleCount = 0;
                }
                $candidateStart ??= $at->copy();
                $lastQualifying = $at->copy();
                $sampleCount++;
                $phase = $active ? 'confirmed' : 'candidate';

                if (! $active
                    && $sampleCount >= self::MIN_SAMPLES
                    && $candidateStart->diffInSeconds($at) >= self::CONFIRM_SECONDS
                ) {
                    $active = true;
                    $phase = 'confirmed';
                    $rejectionReason = null;
                }
                continue;
            }

            if ($active) {
                if ($lastQualifying !== null
                    && $lastQualifying->diffInSeconds($at) > self::HOLD_SECONDS
                ) {
                    return $this->decorate(
                        $this->inactive($lastQualifying, 'current_lost', $sampleCount),
                        'ending', $candidateStart, $lastPositiveCurrent, $lastRiding, $lastGpsSpeed, 'stale_bms',
                    );
                }
                $phase = 'ending';
                $rejectionReason = 'current_gap';
                continue;
            }

            if ($lastQualifying !== null
                && $lastQualifying->diffInSeconds($at) > self::MAX_CANDIDATE_GAP_SECONDS
            ) {
                $rejectionReason = 'insufficient_duration';
                $candidateStart = null;
                $lastQualifying = null;
                $sampleCount = 0;
                $phase = 'idle';
            }
        }

        if ($active && $lastQualifying !== null
            && $lastQualifying->diffInSeconds($now) > self::HOLD_SECONDS
        ) {
            return $this->decorate(
                $this->inactive($lastQualifying, 'telemetry_stale', $sampleCount),
                'ending', $candidateStart, $lastPositiveCurrent, $lastRiding, $lastGpsSpeed, 'stale_bms',
            );
        }

        if ($active && $candidateStart !== null) {
            return $this->decorate([
                'active' => true,
                'started_at' => $candidateStart,
                'ended_at' => null,
                'last_qualifying_at' => $lastQualifying,
                'sample_count' => $sampleCount,
                'reason' => 'confirmed_stationary_current',
                'source' => 'bms_current',
                'confidence' => 0.96,
            ], $phase, $candidateStart, $lastPositiveCurrent, $lastRiding, $lastGpsSpeed, $rejectionReason);
        }

        return $this->decorate([
            'active' => false,
            'started_at' => null,
            'ended_at' => null,
            'last_qualifying_at' => $lastQualifying,
            'sample_count' => $sampleCount,
            'reason' => $candidateStart !== null ? 'confirmation_pending' : 'not_charging',
            'source' => 'bms_current',
            'confidence' => $candidateStart !== null ? 0.55 : 0.0,
        ], $candidateStart !== null ? 'candidate' : 'idle', $candidateStart, $lastPositiveCurrent, $lastRiding, $lastGpsSpeed,
            $candidateStart !== null ? ($sampleCount < self::MIN_SAMPLES ? 'insufficient_frames' : 'insufficient_duration') : $rejectionReason);
    }

    /** @param array<string, mixed> $frame */
    public function isCandidate(array $frame): bool
    {
        if (! is_numeric($frame['current_a'] ?? null)
            || (float) $frame['current_a'] < self::MIN_CURRENT_A
        ) {
            return false;
        }
        return ! $this->isMoving($frame);
    }

    /** @param array<string, mixed> $frame */
    public function isMoving(array $frame): bool
    {
        if (($frame['riding'] ?? null) === true || (bool) ($frame['riding'] ?? false) === true) {
            return true;
        }
        return is_numeric($frame['gps_speed_mps'] ?? null)
            && (float) $frame['gps_speed_mps'] > self::MOVING_SPEED_MPS;
    }

    /** @param array<string, mixed> $frame */
    private static function at(array $frame): Carbon
    {
        $at = $frame['at'] ?? $frame['captured_at'] ?? $frame['created_at'] ?? null;
        return $at instanceof Carbon ? $at->copy() : Carbon::parse((string) $at);
    }

    /** @return array<string, mixed> */
    private function inactive(?Carbon $lastQualifying, string $reason, int $sampleCount): array
    {
        return [
            'active' => false,
            'started_at' => null,
            'ended_at' => $lastQualifying,
            'last_qualifying_at' => $lastQualifying,
            'sample_count' => $sampleCount,
            'reason' => $reason,
            'source' => 'bms_current',
            'confidence' => 0.9,
        ];
    }

    /** @return array<string, mixed> */
    private function decorate(
        array $result,
        string $phase,
        ?Carbon $candidateStart,
        ?float $lastPositiveCurrent,
        ?bool $lastRiding,
        ?float $lastGpsSpeed,
        ?string $rejectionReason,
    ): array {
        $result['state'] = $phase;
        $result['canonical_started_at'] = $result['started_at'] ?? null;
        $result['detection_source'] = $result['source'] ?? 'bms_current';
        $result['rejection_reason'] = $rejectionReason;
        $result['diagnostics'] = [
            'state' => $phase,
            'candidate_started_at' => $candidateStart,
            'candidate_frame_count' => $result['sample_count'] ?? 0,
            'last_candidate_frame_at' => $result['last_qualifying_at'] ?? null,
            'last_positive_current' => $lastPositiveCurrent,
            'last_riding' => $lastRiding,
            'last_gps_speed' => $lastGpsSpeed,
            'canonical_started_at' => $result['started_at'] ?? null,
            'detection_source' => $result['source'] ?? 'bms_current',
            'rejection_reason' => $rejectionReason,
        ];
        return $result;
    }
}
