<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\Response;

/**
 * Brute-force guard for the dashboard login.
 *
 * Tracks consecutive failed logins per real client IP. Caddy terminates TLS on
 * loopback and is trusted in bootstrap/app.php, so request->ip() returns the
 * real client IP from X-Forwarded-For (direct LAN hits on :8000 keep their own
 * peer IP). After MAX_FAILURES within WINDOW_MINUTES the IP is blocked for
 * BLOCK_MINUTES. The controller calls registerFailure() on a wrong password and
 * clear() on success.
 */
class LoginBruteForceGuard
{
    private const MAX_FAILURES = 10;
    private const WINDOW_MINUTES = 15;
    private const BLOCK_MINUTES = 15;

    public function handle(Request $request, Closure $next): Response
    {
        if (self::isBlocked($request->ip())) {
            return response()->json([
                'ok' => false,
                'errors' => [['code' => 'too_many_attempts', 'message' => '登录尝试过于频繁，请 '.self::BLOCK_MINUTES.' 分钟后再试']],
            ], 429);
        }

        return $next($request);
    }

    public static function isBlocked(string $ip): bool
    {
        return Cache::has(self::blockKey($ip));
    }

    public static function registerFailure(string $ip): void
    {
        $failKey = self::failKey($ip);
        $count = (int) Cache::get($failKey, 0) + 1;
        Cache::put($failKey, $count, now()->addMinutes(self::WINDOW_MINUTES));

        if ($count >= self::MAX_FAILURES) {
            Cache::put(self::blockKey($ip), true, now()->addMinutes(self::BLOCK_MINUTES));
        }
    }

    public static function clear(string $ip): void
    {
        Cache::forget(self::failKey($ip));
        Cache::forget(self::blockKey($ip));
    }

    private static function failKey(string $ip): string
    {
        return 'dash_login_fail:'.$ip;
    }

    private static function blockKey(string $ip): string
    {
        return 'dash_login_block:'.$ip;
    }
}
