<?php

namespace App\Services\Battery;

use App\Models\BmsLiveSnapshot;
use App\Models\ChargeEvent;
use App\Models\DeviceSnapshot;
use Illuminate\Support\Carbon;

/**
 * Persistence/read facade for the canonical charging state. Every API and
 * notification surface calls this service instead of inspecting raw current
 * or the vendor charging bit independently.
 */
class ChargingStateService
{
    private const WINDOW_MINUTES = 20;
    private const VENDOR_FALLBACK_SECONDS = 120;
    private const MIN_EVENT_SECONDS = 120;
    private const MAX_OPEN_EVENT_SECONDS = 6 * 60 * 60;

    public function __construct(private readonly ChargingStateDetector $detector) {}

    /** Record a newly stored BMS frame and synchronise the charge event table. */
    public function ingest(string $deviceSn, Carbon $at, ?float $voltage, ?float $current, ?float $soc, ?array $temps, ?bool $riding = null, ?float $gpsSpeedMps = null): array
    {
        $this->expireStaleOpenEvents($deviceSn, $at, $voltage);
        $state = $this->current($deviceSn, $at);
        $open = ChargeEvent::query()->where('device_sn', $deviceSn)->whereNull('ended_at')->orderByDesc('started_at')->first();

        if ($state['active']) {
            if ($open === null) {
                $open = ChargeEvent::query()->create([
                    'device_sn' => $deviceSn,
                    'started_at' => $state['started_at'] ?? $at,
                    'start_voltage' => $voltage,
                    'avg_temp' => $this->averageTemp($temps),
                    'peak_voltage' => $voltage,
                    'is_full_charge' => false,
                    'detection_method' => 'canonical_stationary_bms',
                ]);
            } else {
                $peak = $voltage !== null ? max((float) ($open->peak_voltage ?? 0), $voltage) : $open->peak_voltage;
                $open->forceFill([
                    'peak_voltage' => $peak,
                    'avg_temp' => $this->blendTemp($open->avg_temp, $this->averageTemp($temps)),
                    'detection_method' => $open->detection_method ?: 'canonical_stationary_bms',
                ])->save();
            }
            return $state;
        }

        if ($open !== null) {
            $endedAt = ! empty($state['ended_at']) ? Carbon::parse((string) $state['ended_at']) : $at;
            $duration = Carbon::parse($open->started_at)->diffInSeconds($endedAt);
            if ($duration < self::MIN_EVENT_SECONDS) {
                $open->delete();
            } else {
                $open->forceFill([
                    'ended_at' => $endedAt,
                    'end_voltage' => $voltage,
                    'detection_method' => $open->detection_method ?: 'canonical_stationary_bms',
                ])->save();
            }
        }
        return $state;
    }

    /** @return array{active:bool, started_at:?string, ended_at:?string, reason:string, source:string, confidence:float, sample_count:int} */
    public function current(string $deviceSn, ?Carbon $now = null): array
    {
        $now ??= Carbon::now();
        // A read path can be the first request after a relay outage. Expire
        // orphaned open rows here as well as during ingest, so history and
        // notifications cannot keep presenting yesterday's session as open.
        $this->expireStaleOpenEvents($deviceSn, $now);
        $frames = BmsLiveSnapshot::query()
            ->where('device_sn', $deviceSn)
            ->where('is_heartbeat', false)
            ->where('is_backfill', false)
            ->where('crc_ok', true)
            ->whereNotNull('current_a')
            ->where('captured_at', '>=', $now->copy()->subMinutes(self::WINDOW_MINUTES))
            ->orderBy('captured_at')
            ->get()
            ->map(static fn (BmsLiveSnapshot $frame): array => [
                'at' => $frame->captured_at ?? $frame->created_at,
                'current_a' => $frame->current_a !== null ? (float) $frame->current_a : null,
                'riding' => $frame->riding,
                'gps_speed_mps' => $frame->gps_speed_mps !== null ? (float) $frame->gps_speed_mps : null,
            ])->all();

        if ($frames !== []) {
            $state = $this->detector->evaluate($frames, $now);
            // The rolling detector window is intentionally short, but an
            // already-open event may have started before that window. Keep
            // the persisted event origin so a later poll never moves
            // charging_started_at forward and re-describes a one-hour-old
            // charge as if it had just begun.
            if ($state['active']) {
                $open = ChargeEvent::query()
                    ->where('device_sn', $deviceSn)
                    ->whereNull('ended_at')
                    ->orderByDesc('started_at')
                    ->first();
                if ($open?->started_at !== null && ! $this->isStale($open, $now)) {
                    $state['started_at'] = Carbon::parse($open->started_at);
                } elseif ($open?->started_at !== null) {
                    $state['rejection_reason'] = 'stale_charge_event';
                    $state['diagnostics']['rejection_reason'] = 'stale_charge_event';
                }
            }
            return $this->serialise($state);
        }

        // Cloud-only snapshots remain a conservative compatibility fallback
        // when no board frame exists. If a BMS stream exists, it always wins;
        // this prevents a vendor bit from resurrecting a regen false positive.
        // A recent movement frame vetoes the low-confidence vendor fallback,
        // even when that frame has no current value of its own.
        $movementSeen = BmsLiveSnapshot::query()
            ->where('device_sn', $deviceSn)
            ->where('is_heartbeat', false)
            ->where('is_backfill', false)
            ->where('captured_at', '>=', $now->copy()->subSeconds(self::VENDOR_FALLBACK_SECONDS))
            ->where(function ($query) {
                $query->where('riding', true)
                    ->orWhere('gps_speed_mps', '>', ChargingStateDetector::MOVING_SPEED_MPS);
            })
            ->exists();
        if ($movementSeen) {
            $diagnostics = $this->emptyDiagnostics('idle', 'canonical_bms', 'moving');
            return [
                'active' => false,
                'started_at' => null,
                'ended_at' => null,
                'reason' => 'vendor_movement_veto',
                'source' => 'canonical_bms',
                'confidence' => 0.0,
                'sample_count' => 0,
                'state' => 'idle',
                'rejection_reason' => 'moving',
                'canonical_started_at' => null,
                'detection_source' => 'canonical_bms',
                'diagnostics' => $diagnostics,
            ];
        }

        $snapshot = DeviceSnapshot::query()
            ->whereHas('device', static fn ($q) => $q->where('sn', $deviceSn))
            ->latest('created_at')->first();
        if ($snapshot !== null
            && (int) $snapshot->charging_state === 1
            && $snapshot->created_at !== null
            && $snapshot->created_at->diffInSeconds($now) <= self::VENDOR_FALLBACK_SECONDS
        ) {
            $startedAt = $snapshot->created_at->toISOString();
            $diagnostics = $this->emptyDiagnostics('confirmed', 'vendor_status', null);
            $diagnostics['canonical_started_at'] = $startedAt;
            return [
                'active' => true,
                'started_at' => $startedAt,
                'ended_at' => null,
                'reason' => 'vendor_status_without_bms',
                'source' => 'vendor_status',
                'confidence' => 0.45,
                'sample_count' => 0,
                'state' => 'confirmed',
                'detection_source' => 'vendor_status',
                'rejection_reason' => null,
                'canonical_started_at' => $startedAt,
                'diagnostics' => $diagnostics,
            ];
        }

        $diagnostics = $this->emptyDiagnostics('idle', 'canonical_bms', 'stale_bms');
        return [
            'active' => false,
            'started_at' => null,
            'ended_at' => null,
            'reason' => 'not_charging',
            'source' => 'canonical_bms',
            'confidence' => 0.0,
            'sample_count' => 0,
            'state' => 'idle',
            'detection_source' => 'canonical_bms',
            'rejection_reason' => 'stale_bms',
            'canonical_started_at' => null,
            'diagnostics' => $diagnostics,
        ];
    }

    /** @param array<string, mixed> $state */
    private function serialise(array $state): array
    {
        foreach (['started_at', 'ended_at'] as $key) {
            if (($state[$key] ?? null) instanceof Carbon) {
                $state[$key] = $state[$key]->toISOString();
            }
        }
        if (isset($state['diagnostics']) && is_array($state['diagnostics'])) {
            foreach (['candidate_started_at', 'last_candidate_frame_at', 'canonical_started_at'] as $key) {
                if (($state['diagnostics'][$key] ?? null) instanceof Carbon) {
                    $state['diagnostics'][$key] = $state['diagnostics'][$key]->toISOString();
                }
            }
        }
        return $state;
    }

    private function isStale(ChargeEvent $event, Carbon $at): bool
    {
        return Carbon::parse($event->started_at)->addSeconds(self::MAX_OPEN_EVENT_SECONDS)->lessThan($at);
    }

    private function expireStaleOpenEvents(string $deviceSn, Carbon $at, ?float $voltage = null): void
    {
        $cutoff = $at->copy()->subSeconds(self::MAX_OPEN_EVENT_SECONDS);
        ChargeEvent::query()
            ->where('device_sn', $deviceSn)
            ->whereNull('ended_at')
            ->where('started_at', '<', $cutoff)
            ->get()
            ->each(fn (ChargeEvent $event) => $this->closeStale($event, $at, $voltage));
    }

    /** @return array<string, mixed> */
    private function emptyDiagnostics(string $state, string $source, ?string $reason): array
    {
        return [
            'state' => $state,
            'candidate_started_at' => null,
            'candidate_frame_count' => 0,
            'last_candidate_frame_at' => null,
            'last_positive_current' => null,
            'last_riding' => null,
            'last_gps_speed' => null,
            'canonical_started_at' => null,
            'detection_source' => $source,
            'rejection_reason' => $reason,
        ];
    }

    private function closeStale(ChargeEvent $event, Carbon $at, ?float $voltage): void
    {
        $started = Carbon::parse($event->started_at);
        $ended = $started->copy()->addSeconds(self::MAX_OPEN_EVENT_SECONDS);
        if ($ended->greaterThan($at)) $ended = $at->copy();
        $duration = $started->diffInSeconds($ended);
        if ($duration < self::MIN_EVENT_SECONDS) {
            $event->delete();
            return;
        }
        $event->forceFill([
            'ended_at' => $ended,
            'end_voltage' => $voltage,
            'detection_method' => $event->detection_method ?: 'canonical_stationary_bms',
        ])->save();
    }

    /** @param ?array<int, mixed> $temps */
    private function averageTemp(?array $temps): ?float
    {
        $values = array_values(array_filter($temps ?? [], 'is_numeric'));
        return $values === [] ? null : array_sum($values) / count($values);
    }

    private function blendTemp(mixed $old, ?float $new): mixed
    {
        if ($new === null) return $old;
        return $old === null ? $new : ((float) $old * 0.9 + $new * 0.1);
    }
}
