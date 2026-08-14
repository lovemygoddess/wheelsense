<?php
/**
 * SpeedAnalyzer 单元测试
 *
 * 运行方式:
 *   php tests/SpeedAnalyzerTest.php
 *
 * 锁定项:
 *   1. trail col4 是 mph，必须 ×1.60934 转 km/h
 *   2. 动态速度上限：<2km→50, <5km→85, else 95
 *   3. GPS 不可信检测：有效点 <30% 原始点时返回 gps_unreliable
 *   4. 多峰聚类：max 值 ±5 km/h 范围内 ≥5 个点 → multi_peak
 *   5. 短途骑行 GPS 噪声被正确过滤
 */

require_once __DIR__ . '/../vendor/autoload.php';

use App\Services\SpeedAnalyzer;

$pass = 0;
$fail = 0;

function assert_eq($actual, $expected, $label) {
    global $pass, $fail;
    if ($actual === $expected) {
        echo "  ✓ $label\n";
        $pass++;
    } else {
        echo "  ✗ $label — expected: " . json_encode($expected) . ", got: " . json_encode($actual) . "\n";
        $fail++;
    }
}

function assert_true($cond, $label) {
    global $pass, $fail;
    if ($cond) {
        echo "  ✓ $label\n";
        $pass++;
    } else {
        echo "  ✗ $label — condition false\n";
        $fail++;
    }
}

function assert_close($actual, $expected, $tolerance, $label) {
    global $pass, $fail;
    if (abs($actual - $expected) <= $tolerance) {
        echo "  ✓ $label\n";
        $pass++;
    } else {
        echo "  ✗ $label — expected ~$expected (±$tolerance), got $actual\n";
        $fail++;
    }
}

/** Build a location-neutral synthetic trail; coordinates are ignored by the analyzer. */
function synthetic_trail(array $speedsMph, array $distances = []): string {
    $points = [];
    foreach ($speedsMph as $i => $speed) {
        $distance = $distances[$i] ?? 10;
        $points[] = sprintf('0,0,%s,%.1f', $distance, $speed);
    }
    return implode(';', $points);
}

echo "=== SpeedAnalyzer Tests ===\n\n";

// ─── Test 1: mph → km/h conversion ───
echo "Test 1: mph → km/h conversion\n";
// Need >6 points so after boundary discard (2+2) enough survive for the <3 check
$trail = synthetic_trail(array_fill(0, 10, 50.0));
$analyzer = new SpeedAnalyzer();
$result = $analyzer->analyse($trail, null, 10.0);  // 10km ride → cap 95

// 50 mph = 80.47 km/h
assert_close($result['speed_series'][0]['v'], 80.5, 0.1, '50 mph → ~80.5 km/h');
assert_true($result['point_count'] > 0, 'points produced from valid trail');
assert_true($result['top_speed_kph'] !== null, 'top speed is not null for valid data');

// ─── Test 2: Dynamic speed cap based on mileage ───
echo "\nTest 2: Dynamic speed cap by mileage\n";
// Short ride (<2km): cap 50 km/h → 31 mph
// A point at 40 mph = 64.4 km/h > 50 → filtered out
$trailShort = synthetic_trail(array_fill(0, 10, 40.0));
$resultShort = $analyzer->analyse($trailShort, null, 0.9);  // 0.9km → cap 50
assert_eq($resultShort['top_speed_method'], 'gps_unreliable', '<2km ride with all speeds >50 → gps_unreliable');
assert_eq(count($resultShort['speed_series']), 0, 'no valid points survive 50 km/h cap for 0.9km');

// ─── Test 3: GPS unreliable detection ───
echo "\nTest 3: GPS unreliable detection (short ride noise)\n";
$noisyTrail = synthetic_trail(array_fill(0, 20, 85.0));
$resultNoisy = $analyzer->analyse($noisyTrail, 24.0, 0.9);
assert_eq($resultNoisy['top_speed_method'], 'gps_unreliable', 'synthetic noisy short trail → gps_unreliable');
assert_eq($resultNoisy['top_speed_kph'], null, 'no top speed for gps_unreliable');
assert_eq($resultNoisy['top_speed_note'], 'GPS 数据不可信（短途骑行定位漂移）', 'GPS unreliable note message');
assert_eq(count($resultNoisy['speed_series']), 0, 'no speed series for gps_unreliable');

// ─── Test 4: Multi-peak detection on a synthetic long ride ───
echo "\nTest 4: Multi-peak ceiling clustering (synthetic trail)\n";
$longSpeeds = [];
for ($i = 0; $i < 120; $i++) {
    $longSpeeds[] = ($i % 10 === 5) ? 47.5 : 30.0;
}
$resultLong = $analyzer->analyse(synthetic_trail($longSpeeds), 25.0, 20.0);
assert_eq($resultLong['top_speed_method'], 'multi_peak', 'synthetic long ride → multi_peak');
assert_true($resultLong['top_speed_kph'] !== null, 'synthetic long ride has top speed');
assert_close($resultLong['top_speed_kph'], 76.4, 0.2, '47.5 mph ceiling → ~76.4 km/h');
assert_true(count($resultLong['top_speed_peaks']) >= 3, 'synthetic long ride has ≥3 peak markers');
assert_true($resultLong['point_count'] > 100, 'synthetic long ride has >100 valid points');
assert_true($resultLong['speed_series'][0]['v'] > 0, 'first speed value is positive');
assert_true($resultLong['speed_series'][0]['v'] < 95, 'speed values are below 95 km/h cap');

// ─── Test 5: Unit verification — trail col4 is NOT km/h ───
echo "\nTest 5: Verify col4 is mph not km/h\n";
// If col4 were km/h, the 47.5 sample would remain 47.5 rather than ~76.4.
$maxSpeed = max(array_map(fn($p) => $p['v'], $resultLong['speed_series']));
assert_true($maxSpeed > 70, 'max speed > 70 km/h confirms mph conversion');
assert_true($maxSpeed < 80, 'max speed stays within the synthetic expected range');

// ─── Test 6: GPS jump filtering (col3=0 points) ───
echo "\nTest 6: GPS jump filtering (col3=0)\n";
// Trail with a col3=0 point that has high speed
$jumpSpeeds = array_fill(0, 10, 30.0);
$jumpSpeeds[5] = 85.0;
$jumpDistances = array_fill(0, 10, 10);
$jumpDistances[5] = 0;
$trailWithJump = synthetic_trail($jumpSpeeds, $jumpDistances);
$resultJump = $analyzer->analyse($trailWithJump, null, 10.0);
// The 85.0 mph point = 136.8 km/h > 95 cap → filtered anyway
// But also col3=0 + speed>0 → GPS jump filtered
assert_true($resultJump['point_count'] > 0, 'trail with GPS jump has valid points');
$jumpFiltered = true;
foreach ($resultJump['speed_series'] as $p) {
    if ($p['v'] > 130) {  // 85 mph = 136.8 km/h
        $jumpFiltered = false;
        break;
    }
}
assert_true($jumpFiltered, 'GPS jump point (col3=0, 85mph) is filtered out');

// ─── Test 7: Empty trail ───
echo "\nTest 7: Empty trail\n";
$resultEmpty = $analyzer->analyse('', null, null);
assert_eq($resultEmpty['point_count'], 0, 'empty trail → 0 points');
assert_eq($resultEmpty['top_speed_kph'], null, 'empty trail → null top speed');

// ─── Test 8: API avg fallback ───
echo "\nTest 8: API avg speed fallback\n";
$resultFallback = $analyzer->analyse('', 25.0, null);
assert_eq($resultFallback['top_speed_kph'], 25.0, 'empty trail with api_avg → fallback value');
assert_eq($resultFallback['top_speed_method'], 'api_avg_fallback', 'method = api_avg_fallback');

echo "\n=== Results: $pass passed, $fail failed ===\n";
exit($fail > 0 ? 1 : 0);
