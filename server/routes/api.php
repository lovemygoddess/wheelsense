<?php

use App\Http\Controllers\Api\BmsLiveSnapshotController;
use App\Http\Controllers\Api\DashboardController;
use App\Http\Controllers\Api\RelayConfigController;
use App\Http\Controllers\Api\EzvizController;
use App\Http\Controllers\Api\HealthController;
use App\Http\Controllers\Api\RelayCommandController;
use App\Http\Controllers\Api\RelayApkController;
use App\Http\Controllers\Api\TpmsCaptureController;
use App\Http\Controllers\Api\TpmsController;
use App\Http\Controllers\Api\DashboardApkController;
use Illuminate\Support\Facades\Route;

// LAN access gate — public endpoints (login + status) are NOT gated, but rate-limited.
Route::post('/auth/login', [DashboardController::class, 'authLogin'])->middleware(['throttle:5,1', 'login.lockout']);
Route::get('/auth/status', [DashboardController::class, 'authStatus']);
Route::post('/auth/logout', [DashboardController::class, 'authLogout']);
// Silent re-auth for the app when the short session expires (refresh-token rotation).
Route::post('/auth/refresh', [DashboardController::class, 'authRefresh'])->middleware('throttle:10,1');

// BMS relay ingestion — token-authenticated (APK cannot do session auth).
// The Android BMS relay APK posts here with Authorization: Bearer <BMS_RELAY_TOKEN>.
Route::post('/bms-live-snapshot', [BmsLiveSnapshotController::class, 'store'])
    ->middleware('throttle:90,1');

// Offline relay backlog flush. The tail-box phone has no SIM, so it buffers
// locally and dumps everything the moment a hotspot appears — a week of
// parked time can arrive as a few hundred back-to-back batches. The 30/min
// limit on the live endpoint above would throttle that into an hours-long
// drain, so this one gets its own generous budget. Volume is bounded anyway:
// 500 rows per request, and the client only deletes what the server ack'd.
Route::post('/relay/batch', \App\Http\Controllers\Api\RelayBatchController::class)
    ->middleware('throttle:120,1');

// Home-screen widget summary — token-authenticated read-only endpoint.
// The widget provider process fetches this directly every ~30 min without
// the app being alive, so it cannot use the session gate.
Route::get('/widget/summary', \App\Http\Controllers\Api\WidgetSummaryController::class)
    ->middleware('throttle:30,1');

// Relay remote-control: poll / result / photo — token-authenticated (APK, no session).
Route::post('/relay/commands/poll', [RelayCommandController::class, 'poll'])
    ->middleware('throttle:120,1');
Route::post('/relay/commands/{id}/result', [RelayCommandController::class, 'result'])
    ->middleware('throttle:120,1');
Route::post('/relay/photo', [RelayCommandController::class, 'uploadPhoto'])
    ->middleware('throttle:60,1');
// Relay pulls its remote config here (RelayAuth, HMAC-signed POST).
Route::post('/relay/config', [RelayConfigController::class, 'pull'])
    ->middleware('throttle:120,1');
// Relay downloads the latest APK for self-update (RelayAuth, HMAC-signed GET).
Route::get('/relay/apk', [RelayApkController::class, 'download'])
    ->middleware('throttle:30,1');

// Dashboard self-update: app downloads the latest APK to the phone, then the
// system installer prompts the user (no root / no silent install). The binary
// endpoint is token-gated (a short-lived token issued by /dashboard/apk/info)
// because the native download client cannot send the session cookie.
Route::get('/dashboard/apk', [DashboardApkController::class, 'download'])
    ->middleware('throttle:10,1');

// Everything below requires an unlocked dashboard session.
Route::middleware('dashboard.gate')->group(function (): void {
    // 仪表盘自更新：登录用户可查发布包元信息 + 领取短时下载 token。
    Route::get('/dashboard/apk/info', [DashboardApkController::class, 'info']);

    Route::post('/auth/change-password', [DashboardController::class, 'authChangePassword']);
    Route::post('/ninebot/login', [DashboardController::class, 'login'])->middleware('throttle:3,1');
    Route::post('/ninebot/login-code', [DashboardController::class, 'loginCode'])->middleware('throttle:3,1');
    Route::get('/ninebot/whoami', [DashboardController::class, 'whoami']);
    Route::get('/dashboard/vehicles', [DashboardController::class, 'vehicles']);
    Route::get('/dashboard/vehicles/{sn}/snapshot', [DashboardController::class, 'snapshot']);
    Route::get('/dashboard/vehicles/{sn}/history', [DashboardController::class, 'history']);
    // Ninebot cloud ride history. Declared before the {rideId} trail route.
    Route::get('/dashboard/vehicles/{sn}/rides', [DashboardController::class, 'rides']);
    Route::get('/dashboard/vehicles/{sn}/rides/{rideId}/trail', [DashboardController::class, 'rideTrail']);
    Route::post('/dashboard/vehicles/{sn}/command/{action}', [DashboardController::class, 'command']);
    Route::get('/config/map', [DashboardController::class, 'mapConfig']);
    // Server-side AMap static-map proxy (phone can't call restapi.amap.com
    // directly: key is IP-whitelisted + <Image> won't send the session cookie).
    Route::get('/map/static', [DashboardController::class, 'mapStatic'])->middleware('throttle:120,1');
    Route::get('/dashboard/battery-overview', [DashboardController::class, 'batteryOverview']);
    Route::get('/dashboard/settings', [DashboardController::class, 'getSettings']);
    Route::put('/dashboard/settings', [DashboardController::class, 'updateSettings']);
    Route::post('/dashboard/vehicles/{sn}/image', [DashboardController::class, 'uploadVehicleImage']);
    Route::get('/dashboard/vehicles/{sn}/image', [DashboardController::class, 'getVehicleImage']);
    Route::get('/dashboard/bms-relay/status', [DashboardController::class, 'relayStatus']);
    Route::post('/dashboard/bms-relay/command', [RelayCommandController::class, 'issue']);
    Route::get('/dashboard/bms-relay/commands', [RelayCommandController::class, 'listForDashboard']);
    // Relay remote config: dashboard view + save (relay pulls its own via /relay/config).
    Route::get('/dashboard/relay/config', [RelayConfigController::class, 'show']);
    Route::post('/dashboard/relay/config', [RelayConfigController::class, 'update']);
    Route::get('/dashboard/health/summary', [HealthController::class, 'index']);
    Route::post('/bms-debug-log', [DashboardController::class, 'bmsDebugLog']);
    Route::get('/bms-debug-log', [DashboardController::class, 'bmsDebugView']);

    // TPMS 原始广播抓包查看（调试用，Task #9 落地解析字段后可保留为原始视图）
    Route::get('/tpms/captures', [TpmsCaptureController::class, 'index']);
    // TPMS 结构化解码读数（前/后轮压，服务端解压，relay 无需改动）
    Route::get('/tpms/current', [TpmsController::class, 'current']);

    // BMS live snapshots — dashboard retrieval (ingestion is above, outside gate)
    Route::get('/bms-live-snapshot', [BmsLiveSnapshotController::class, 'index']);

    // EZVIZ camera proxy (framework — returns 503 until credentials configured)
    Route::get('/ezviz/devices', [EzvizController::class, 'devices']);
    Route::get('/ezviz/live/{deviceSerial}', [EzvizController::class, 'live']);
    Route::get('/ezviz/live-url/{deviceSerial}', [EzvizController::class, 'liveUrl']);
    Route::get('/ezviz/snapshot-url/{deviceSerial}', [EzvizController::class, 'snapshotUrl']);
    Route::get('/ezviz/alarms/{deviceSerial}', [EzvizController::class, 'alarms']);
});
