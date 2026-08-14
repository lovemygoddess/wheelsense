<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

/**
 * Long-lived "remember this device" token for silent session re-establishment.
 *
 * Stored server-side in the cache (the dashboard is a single shared password, so
 * the token only re-unlocks the session — there is no per-user identity). Tokens
 * rotate on every use: the old one is invalidated and a new one issued, so a
 * stolen token has a limited window. Lifetime is deliberately long; the
 * short-lived session (SESSION_LIFETIME) is what bounds active exposure.
 */
class DashboardRefreshToken
{
    private const TTL_DAYS = 30;
    private const CACHE_PREFIX = 'dash_refresh:';

    public static function issue(): string
    {
        $token = Str::random(64);
        Cache::put(self::CACHE_PREFIX.$token, true, now()->addDays(self::TTL_DAYS));

        return $token;
    }

    public static function isValid(string $token): bool
    {
        return is_string($token) && $token !== '' && Cache::has(self::CACHE_PREFIX.$token);
    }

    /** Invalidate a token (e.g. on logout, or after rotation). */
    public static function revoke(string $token): void
    {
        if (is_string($token) && $token !== '') {
            Cache::forget(self::CACHE_PREFIX.$token);
        }
    }

    /** Revoke the old token and issue a fresh one (rotation). */
    public static function rotate(string $oldToken): string
    {
        self::revoke($oldToken);

        return self::issue();
    }
}
