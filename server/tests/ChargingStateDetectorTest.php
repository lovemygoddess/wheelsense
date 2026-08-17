<?php

require_once __DIR__ . '/../vendor/autoload.php';

use App\Services\Battery\ChargingStateDetector;
use App\Services\Battery\ChargingStateService;
use App\Models\ChargeEvent;
use Illuminate\Support\Carbon;

$pass = 0;
$fail = 0;
$check = static function (bool $ok, string $label) use (&$pass, &$fail): void {
    echo ($ok ? '[PASS] ' : '[FAIL] ') . $label . PHP_EOL;
    $ok ? $pass++ : $fail++;
};

$detector = new ChargingStateDetector();
$frame = static fn (int $seconds, float $current, ?bool $riding = false, ?float $speed = 0.0): array => [
    'at' => Carbon::parse('2026-08-15 12:00:00')->addSeconds($seconds),
    'current_a' => $current,
    'riding' => $riding,
    'gps_speed_mps' => $speed,
];

// A: one positive sample must not start an event.
$check(! $detector->evaluate([$frame(0, 8.0)], Carbon::parse('2026-08-15 12:00:10'))['active'], 'A: one positive sample is only a candidate');

// Relay cadence regression: a 120-second parked gate cannot satisfy the
// detector, while the temporary 10-second candidate-monitoring cadence can.
$sparseIdle = $detector->evaluate(
    [$frame(0, 8), $frame(120, 8), $frame(240, 8)],
    Carbon::parse('2026-08-15 12:04:00'),
);
$check(! $sparseIdle['active'] && $sparseIdle['reason'] === 'confirmation_pending', 'A2: sparse 120s idle frames never confirm');
$candidateMonitoring = $detector->evaluate(
    [$frame(0, 8), $frame(10, 8), $frame(20, 8), $frame(30, 8), $frame(45, 8)],
    Carbon::parse('2026-08-15 12:01:00'),
);
$check($candidateMonitoring['active'], 'A3: 10s candidate-monitoring frames confirm');
$check($candidateMonitoring['started_at']?->getTimestamp() === Carbon::parse('2026-08-15 12:00:00')->getTimestamp(), 'A3: monitored confirmation keeps plug-in start time');
$check(isset($candidateMonitoring['diagnostics']['state'], $candidateMonitoring['diagnostics']['candidate_frame_count'], $candidateMonitoring['diagnostics']['last_positive_current']), 'A3: detector diagnostics expose candidate evidence');
$activeSparseTail = $detector->evaluate(
    [$frame(0, 8), $frame(10, 8), $frame(20, 8), $frame(45, 8), $frame(120, 8)],
    Carbon::parse('2026-08-15 12:02:00'),
);
$check($activeSparseTail['active'], 'A3: confirmed state tolerates a sparse frame within end hysteresis');

// B: a stable stationary sequence confirms after the temporal window.
$confirmed = $detector->evaluate([$frame(0, 8), $frame(20, 8), $frame(50, 7.9)], Carbon::parse('2026-08-15 12:01:00'));
$check($confirmed['active'], 'B: sustained stationary current confirms charging');
$check($confirmed['started_at']?->getTimestamp() === Carbon::parse('2026-08-15 12:00:00')->getTimestamp(), 'B: started_at is first confirmed candidate');

// C/D: regen current with riding or GPS speed is never charging, even in
// repeated downhill pulses or a red-light stop followed by more riding.
$check(! $detector->evaluate([$frame(0, 9, true), $frame(20, 8, true), $frame(50, 9, true)], Carbon::parse('2026-08-15 12:01:00'))['active'], 'C: riding-positive current is regen');
$check(! $detector->evaluate([$frame(0, 9, true, 5.0), $frame(10, 8, true, 4.0), $frame(20, 9, true, 5.0), $frame(30, 8, true, 4.0)], Carbon::parse('2026-08-15 12:01:00'))['active'], 'C: repeated downhill recovery stays inactive');
$check(! $detector->evaluate([$frame(0, 9, true, 3.0), $frame(20, 8, false, 0.0), $frame(35, 9, true, 3.0), $frame(70, 8, true, 4.0)], Carbon::parse('2026-08-15 12:01:00'))['active'], 'D: red-light regen followed by riding stays inactive');

// E: a short charger blip never confirms.
$check(! $detector->evaluate([$frame(0, 0.7), $frame(10, 0.8)], Carbon::parse('2026-08-15 12:01:00'))['active'], 'E: short low-current blip remains inactive');
$check(! $detector->evaluate([$frame(0, 8), $frame(10, 8), $frame(20, 8), $frame(30, 0)], Carbon::parse('2026-08-15 12:01:00'))['active'], 'E2: short parked push pulse remains inactive');

// F/G: a missed frame is held briefly, but a stale stream ends the state.
$held = $detector->evaluate([$frame(0, 8), $frame(20, 8), $frame(50, 8), $frame(110, 0)], Carbon::parse('2026-08-15 12:01:50'));
$check($held['active'], 'F: hysteresis holds through a short non-qualifying gap');
$stale = $detector->evaluate([$frame(0, 8), $frame(20, 8), $frame(50, 8)], Carbon::parse('2026-08-15 12:04:00'));
$check(! $stale['active'] && $stale['reason'] === 'telemetry_stale', 'G: stale telemetry ends charging');

// E: riding must end before a later stationary charger sequence can confirm.
$laterCharger = $detector->evaluate([
    $frame(0, -4, true, 3.0), $frame(20, 7, true, 3.0),
    $frame(60, 0, false, 0.0), $frame(80, 7.5, false, 0.0),
    $frame(110, 7.4, false, 0.0), $frame(140, 7.3, false, 0.0),
], Carbon::parse('2026-08-15 12:03:00'));
$check($laterCharger['active'], 'E: stationary charger confirms after riding ends');

// H/I: vendor state cannot override movement; threshold and tail current are stable.
$vendorWhileMoving = $detector->evaluate([
    $frame(0, 8, true, 3.0) + ['vendor_charging' => true],
    $frame(20, 8, true, 3.0) + ['vendor_charging' => true],
    $frame(50, 8, true, 3.0) + ['vendor_charging' => true],
], Carbon::parse('2026-08-15 12:01:00'));
$check(! $vendorWhileMoving['active'], 'H: vendor charging bit cannot override riding');
$check(! $detector->evaluate([$frame(0, 0.59), $frame(20, 0.59), $frame(50, 0.59)], Carbon::parse('2026-08-15 12:01:00'))['active'], 'H: sub-threshold current is not charging');
$check(! $detector->evaluate([$frame(0, 8), $frame(20, 8), $frame(30, 8, true), $frame(80, 8)], Carbon::parse('2026-08-15 12:02:00'))['active'], 'I: movement resets a pending sequence');
$tail = $detector->evaluate([$frame(0, 8), $frame(20, 8), $frame(50, 8), $frame(80, 0.25)], Carbon::parse('2026-08-15 12:02:00'));
$check($tail['active'], 'I: a brief low-current tail does not flap an active session');

// J: stale open events are bounded to one six-hour charging session and do
// not become the origin for the next day's plug-in.
$service = new ChargingStateService($detector);
$stalePolicy = new ReflectionMethod($service, 'isStale');
$stalePolicy->setAccessible(true);
$oldEvent = new class extends ChargeEvent {
    public $started_at = '2026-08-14 12:00:00';
};
$check(! $stalePolicy->invoke($service, $oldEvent, Carbon::parse('2026-08-14 17:59:59')), 'J: open event is valid inside six-hour boundary');
$check($stalePolicy->invoke($service, $oldEvent, Carbon::parse('2026-08-14 18:00:01')), 'J: open event expires after six hours');

echo "Result: {$pass} passed, {$fail} failed" . PHP_EOL;
exit($fail === 0 ? 0 : 1);
