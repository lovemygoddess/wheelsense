<?php

require_once __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\Device;
use App\Models\DeviceSnapshot;
use App\Models\RelayCommand;
use App\Services\Dashboard\PrimaryTelemetryService;
use Illuminate\Support\Facades\Schema;

$pass = 0;
$fail = 0;
$check = static function (bool $condition, string $label) use (&$pass, &$fail): void {
    echo ($condition ? '[PASS] ' : '[FAIL] ') . $label . PHP_EOL;
    $condition ? $pass++ : $fail++;
};

$check(! in_array('shell', RelayCommand::COMMANDS, true), 'arbitrary root shell is not remotely issuable');
$check(! in_array('clear-backlog', RelayCommand::REQUEUEABLE, true), 'destructive backlog clear is never replayed');
$check(! class_exists(App\Services\Calibration\CalibrationOrchestrator::class), 'obsolete calibration orchestrator removed');
$check(! class_exists(App\Services\Calibration\CycleDetector::class), 'legacy cycle estimator removed');
foreach (['voltage_samples', 'consumption_samples', 'charge_cycles'] as $table) {
    $check(! Schema::hasTable($table), "obsolete table {$table} removed");
}

$device = Device::query()->first();
$snapshot = $device ? DeviceSnapshot::query()->where('device_id', $device->id)->latest('created_at')->first() : null;
if ($device !== null) {
    $primary = app(PrimaryTelemetryService::class)->forSnapshot($device, $snapshot);
    foreach (['soc_pct', 'range_km', 'source', 'quality', 'confidence', 'degraded_reason', 'usable_for_range', 'usable_for_safety'] as $key) {
        $check(array_key_exists($key, $primary), "primary telemetry exposes {$key}");
    }
    $check($primary['confidence'] >= 0 && $primary['confidence'] <= 1, 'telemetry confidence is bounded');
} else {
    echo "[SKIP] no device row available for primary telemetry contract\n";
}

echo "Result: {$pass} passed, {$fail} failed\n";
exit($fail === 0 ? 0 : 1);
