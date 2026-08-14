<?php

/**
 * BMS relay HMAC enforcement — integration test.
 *
 * Run (on the server, app must be up):
 *   php tests/BmsRelayHmacTest.php
 *
 * Locks in:
 *   1. A POST with a valid Bearer token but NO X-Relay-Sig is REJECTED (401).
 *   2. A POST with a valid Bearer token AND the correct HMAC signature is
 *      NOT rejected for signature (may still 422 on data, but never 401).
 *   3. A POST with a tampered body + stale signature is REJECTED (401).
 */

require_once __DIR__ . '/../vendor/autoload.php';

$base = 'http://127.0.0.1:8000/api/bms-live-snapshot';

// Read secrets straight from .env (standalone script has no dotenv bootstrap).
$env = file_get_contents(__DIR__ . '/../.env');
$token = preg_match('/^BMS_RELAY_TOKEN=(.*)$/m', $env, $m) ? trim($m[1]) : '';
$secret = preg_match('/^BMS_RELAY_HMAC_SECRET=(.*)$/m', $env, $m) ? trim($m[1]) : '';
if ($secret === '') {
    echo "BMS_RELAY_HMAC_SECRET missing from .env — the server now fails closed without it.\n";
    exit(1);
}

function post(string $url, string $body, array $headers): int
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 5,
    ]);
    curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return $code;
}

$body = json_encode([
    'device_sn' => 'TESTSN',
    'captured_at' => gmdate('c'),
    'total_voltage_v' => 54.0,
]);
$sig = hash_hmac('sha256', $body, $secret);

$pass = 0;
$fail = 0;
function check(bool $cond, string $label, int &$pass, int &$fail): void
{
    if ($cond) {
        $pass++;
        echo "  [PASS] $label\n";
    } else {
        $fail++;
        echo "  [FAIL] $label\n";
    }
}

echo "BMS relay HMAC test\n";

// 1) token only, no signature -> 401
$code1 = post($base, $body, ["Authorization: Bearer $token", 'Content-Type: application/json']);
check($code1 === 401, "rejects token without signature (got $code1)", $pass, $fail);

// 2) token + valid signature -> not 401 (may be 422 on data, but auth passes)
$code2 = post($base, $body, ["Authorization: Bearer $token", "X-Relay-Sig: $sig", 'Content-Type: application/json']);
check($code2 !== 401, "accepts valid HMAC signature (got $code2)", $pass, $fail);

// 3) tampered body + stale signature -> 401
$tampered = json_encode(['device_sn' => 'TESTSN', 'captured_at' => gmdate('c'), 'total_voltage_v' => 99.9]);
$code3 = post($base, $tampered, ["Authorization: Bearer $token", "X-Relay-Sig: $sig", 'Content-Type: application/json']);
check($code3 === 401, "rejects tampered body with stale signature (got $code3)", $pass, $fail);

echo "\nResult: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
