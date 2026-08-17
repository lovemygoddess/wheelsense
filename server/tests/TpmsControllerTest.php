<?php

/**
 * Synthetic TPMS decoder regression checks.
 *
 * The fixture never embeds a real sensor identifier.  It resolves the
 * controller's configured wheel keys at runtime and rolls every insert back.
 */
require_once __DIR__ . '/../vendor/autoload.php';

$app = require __DIR__ . '/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Http\Controllers\Api\TpmsController;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

$pass = 0;
$fail = 0;
$check = static function (bool $ok, string $label) use (&$pass, &$fail): void {
    echo ($ok ? '[PASS] ' : '[FAIL] ') . $label . PHP_EOL;
    $ok ? $pass++ : $fail++;
};

// Configure only synthetic identifiers for this isolated test. Production
// deployments provide their own values through TPMS_FRONT_MAC/TPMS_REAR_MAC.
$frontMac = 'AA:BB:CC:DD:EE:01';
$rearMac = 'AA:BB:CC:DD:EE:02';
config(['tpms.front_mac' => $frontMac, 'tpms.rear_mac' => $rearMac]);

// Build one valid manufacturer AD for the verified 0x1E01 protocol. The
// payload values are synthetic and contain no real sensor identifiers.
$ad = static function (int $b0, int $b1, int $b2, int $companyId = 0x1E01): string {
    return chr(6) . chr(0xFF) . chr($companyId & 0xFF) . chr(($companyId >> 8) & 0xFF)
        . chr($b0) . chr($b1) . chr($b2);
};
$staticFront = base64_encode($ad(62, 110, 52)); // 2.20 bar, 22°C
$staticRear = base64_encode($ad(63, 113, 48));  // 2.26 bar, 23°C
$hotFront = base64_encode($ad(66, 113, 45));    // 2.26 bar, 26°C
$hotRear = base64_encode($ad(71, 118, 35));     // 2.36 bar, 31°C
$invalidFront = base64_encode($ad(66, 113, 44));
$legacyFront = base64_encode($ad(66, 113, 45, 0x1E00));
$device = 'TEST-TPMS-SYNTHETIC';
$now = Carbon::now()->subMinute();

$insert = static function (string $mac, string $raw, Carbon $capturedAt, string $sensor) use ($device): int {
    return (int) DB::table('tpms_captures')->insertGetId([
        'device_sn' => $device,
        'sensor_name' => $sensor,
        'mac' => $mac,
        'rssi' => -60,
        'raw_bytes' => $raw,
        'manufacturer_data' => '{}',
        'service_data' => '{}',
        'captured_at' => $capturedAt,
        'created_at' => $capturedAt,
        'updated_at' => $capturedAt,
    ]);
};

DB::beginTransaction();
try {
    $frontId = $insert($frontMac, $staticFront, $now, 'SYNTH-FRONT');
    $rearId = $insert($rearMac, $staticRear, $now, 'SYNTH-REAR');
    $readings = app(TpmsController::class)->readings();

    $check($readings['front']['capture_id'] === $frontId, 'latest valid frame is selected for front wheel');
    $check($readings['rear']['capture_id'] === $rearId, 'latest valid frame is selected for rear wheel');
    $check($readings['front']['pressure'] === 2.20 && $readings['front']['temp_c'] === 22, 'front static protocol decode');
    $check($readings['rear']['pressure'] === 2.26 && $readings['rear']['temp_c'] === 23, 'rear static protocol decode');
    $check($readings['front']['checksum_ok'] === true && $readings['rear']['checksum_ok'] === true, 'static protocol checksums are valid');
    $check($readings['front']['capture_id'] !== $readings['rear']['capture_id'], 'front and rear identities remain isolated');

    $hotFrontId = $insert($frontMac, $hotFront, $now->copy()->addSecond(), 'SYNTH-FRONT');
    $hotRearId = $insert($rearMac, $hotRear, $now->copy()->addSecond(), 'SYNTH-REAR');
    $hotReadings = app(TpmsController::class)->readings();
    $check($hotReadings['front']['capture_id'] === $hotFrontId && $hotReadings['front']['pressure'] === 2.26 && $hotReadings['front']['temp_c'] === 26, 'front riding-warm protocol decode');
    $check($hotReadings['rear']['capture_id'] === $hotRearId && $hotReadings['rear']['pressure'] === 2.36 && $hotReadings['rear']['temp_c'] === 31, 'rear riding-warm protocol decode');

    $insert($frontMac, $legacyFront, $now->copy()->addSeconds(2), 'SYNTH-FRONT');
    $afterLegacy = app(TpmsController::class)->readings()['front'];
    $check($afterLegacy['capture_id'] === $hotFrontId, 'unverified 0x1E00 frame is ignored');

    $insert($frontMac, $invalidFront, $now->copy()->addSeconds(3), 'SYNTH-FRONT');
    $afterInvalid = app(TpmsController::class)->readings()['front'];
    $check($afterInvalid['capture_id'] === $hotFrontId && $afterInvalid['checksum_ok'] === true, 'invalid checksum cannot replace last valid frame');

    DB::table('tpms_captures')->where('device_sn', $device)->delete();
    $staleId = $insert($frontMac, $staticFront, $now->copy()->subMinutes(31), 'SYNTH-FRONT');
    $stale = app(TpmsController::class)->readings()['front'];
    $check($stale['capture_id'] === $staleId && $stale['status'] === 'stale', 'stale frame is marked stale instead of live');
} finally {
    DB::rollBack();
}

echo "Result: {$pass} passed, {$fail} failed" . PHP_EOL;
exit($fail === 0 ? 0 : 1);
