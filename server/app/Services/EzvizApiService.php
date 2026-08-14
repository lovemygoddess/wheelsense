<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * EZVIZ Open Platform API client.
 *
 * Framework only — the AppKey/AppSecret must be filled in .env before
 * any endpoint will work. All methods throw if credentials are absent.
 *
 * Token lifecycle: EZVIZ access tokens expire after 7 days. We cache the
 * token in the Laravel cache with a 6-day TTL and auto-refresh on miss.
 * If EZVIZ re-issues a token server-side, the previously cached token dies
 * immediately (code 10001/10002) — we detect that, drop the cache, and
 * retry once with a fresh token.
 *
 * Open Platform docs: https://open.ys7.com/help/30
 */
class EzvizApiService
{
    private const BASE_URL = 'https://open.ys7.com';
    private const CACHE_KEY = 'ezviz:access_token';
    private const CACHE_TTL = 6 * 24 * 60; // 6 days in minutes

    /** EZVIZ business codes meaning "access token expired / invalid". */
    private const TOKEN_ERROR_CODES = [10001, 10002];

    public function __construct(
        private readonly string $appKey,
        private readonly string $appSecret,
    ) {}

    public function isConfigured(): bool
    {
        return $this->appKey !== '' && $this->appSecret !== '';
    }

    /**
     * Get a cached access token, refreshing from EZVIZ if stale.
     */
    public function getAccessToken(): string
    {
        $cached = Cache::get(self::CACHE_KEY);
        if ($cached) {
            return $cached;
        }

        $resp = Http::asForm()->post(self::BASE_URL . '/api/lapp/token/get', [
            'appKey'    => $this->appKey,
            'appSecret' => $this->appSecret,
        ]);

        $body = $resp->json();
        if (!isset($body['data']['accessToken'])) {
            $code = (int) ($body['code'] ?? $resp->status());
            $msg = $this->safeMessage($body['msg'] ?? null);
            Log::error('EZVIZ token refresh failed', ['http_status' => $resp->status(), 'code' => $code, 'msg' => $msg]);
            throw new \RuntimeException('EZVIZ token request failed');
        }

        $token = $body['data']['accessToken'];
        Cache::put(self::CACHE_KEY, $token, now()->addMinutes(self::CACHE_TTL));
        return $token;
    }

    /**
     * List cameras bound to the EZVIZ account.
     * API: POST /api/lapp/device/list
     */
    public function listDevices(): array
    {
        return $this->request('/api/lapp/device/list');
    }

    /**
     * Get live stream URLs for a camera.
     * API: POST /api/lapp/live/video/list
     *
     * @param  string  $deviceSerial  Camera serial number
     * @param  int     $channelNo     Channel number (default 1)
     */
    public function liveVideo(string $deviceSerial, int $channelNo = 1): array
    {
        return $this->request('/api/lapp/live/video/list', [
            'deviceSerial' => $deviceSerial,
            'channelNo'    => max(1, $channelNo),
        ]);
    }

    /**
     * Trigger a snapshot capture on the camera, returns the image URL.
     * API: POST /api/lapp/device/capture
     */
    public function capture(string $deviceSerial, int $channelNo = 1): string
    {
        $data = $this->request('/api/lapp/device/capture', [
            'deviceSerial' => $deviceSerial,
            'channelNo'   => max(1, $channelNo),
        ]);
        return (string) ($data['picUrl'] ?? '');
    }

    /**
     * Get device live status (battery level, signal, disks, etc).
     * API: POST /api/lapp/device/status/get
     *
     * Note the official field typo in the response: `battryStatus` (sic).
     * Battery cams report 0-100; mains-powered cams report -1/-2.
     */
    public function deviceStatus(string $deviceSerial): array
    {
        return $this->request('/api/lapp/device/status/get', [
            'deviceSerial' => $deviceSerial,
        ]);
    }

    /**
     * List alarm events for a camera.
     * API: POST /api/lapp/alarm/device/list
     */
    public function alarmList(string $deviceSerial, int $limit = 20): array
    {
        return $this->request('/api/lapp/alarm/device/list', [
            'deviceSerial' => $deviceSerial,
            'startTime'    => (string) now()->subDays(7)->getTimestampMs(),
            'endTime'      => (string) now()->getTimestampMs(),
            'pageSize'     => max(1, min($limit, 50)),
            'page'         => '0',
        ]);
    }

    /**
     * Central request helper. POSTs to the given path with accessToken, checks the
     * EZVIZ business `code`, retries once on token expiry, and throws on any other
     * error. Previous code ignored `code` entirely, so an invalidated cached token
     * produced silent empty responses that the controller reported as success.
     *
     * @param  array<string, mixed>  $params
     * @return array<string, mixed>  the `data` payload of the successful response
     */
    private function request(string $path, array $params = []): array
    {
        $this->requireConfigured();

        $body = $this->postForm($path, $params);
        $code = (int) ($body['code'] ?? 0);

        // Token died server-side (EZVIZ re-issued) — drop cache and retry once.
        if (in_array($code, self::TOKEN_ERROR_CODES, true)) {
            Cache::forget(self::CACHE_KEY);
            $body = $this->postForm($path, $params);
            $code = (int) ($body['code'] ?? 0);
        }

        if ($code !== 200) {
            $msg = $this->safeMessage($body['msg'] ?? null);
            Log::warning('EZVIZ API error', ['path' => $path, 'code' => $code, 'msg' => $msg]);
            throw new \RuntimeException("EZVIZ request failed: code={$code}");
        }

        return is_array($body['data'] ?? null) ? $body['data'] : [];
    }

    /** @param array<string, mixed> $params */
    private function postForm(string $path, array $params): array
    {
        $resp = Http::asForm()->post(self::BASE_URL . $path, $params + [
            'accessToken' => $this->getAccessToken(),
        ]);
        $body = $resp->json();
        if (!is_array($body)) {
            throw new \RuntimeException("EZVIZ {$path} returned non-JSON response (HTTP {$resp->status()})");
        }
        return $body;
    }

    /** Keep provider diagnostics short and free of URLs, tokens, or response blobs. */
    private function safeMessage(mixed $message): string
    {
        $msg = is_scalar($message) ? trim((string) $message) : '';
        $msg = preg_replace('/https?:\/\/\S+/i', '[url]', $msg) ?? '';
        $msg = preg_replace('/(accessToken|appSecret|appKey|token)\s*[:=]\s*[^\s,;]+/i', '$1=[redacted]', $msg) ?? '';
        return mb_substr($msg !== '' ? $msg : 'unknown', 0, 120);
    }

    private function requireConfigured(): void
    {
        if (!$this->isConfigured()) {
            throw new \RuntimeException('EZVIZ not configured — set EZVIZ_APP_KEY and EZVIZ_APP_SECRET in .env');
        }
    }
}
