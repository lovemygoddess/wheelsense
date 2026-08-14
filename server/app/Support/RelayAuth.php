<?php

namespace App\Support;

use App\ValueObjects\Api\ErrorObject;
use Illuminate\Support\Facades\Log;

/**
 * Shared authentication for the Android relay endpoints.
 *
 * Two secrets, deliberately:
 *
 *  - A bearer token proves only "the caller knows the token". Tokens leak
 *    through logs, proxies and APK teardowns, and a leaked one lets anyone
 *    inject forged pack telemetry — which then feeds the calibration maths
 *    and silently corrupts every derived figure.
 *  - So the body is additionally signed. For the batch endpoint the signature
 *    covers the *uncompressed* JSON: gzip is a transport detail, and signing
 *    compressed bytes would make the signature depend on the compressor's
 *    version.
 *
 * NOTE: reads env() at runtime on purpose — this project must never run
 * `php artisan config:cache` (13 runtime env() call sites would all return
 * null). Centralised here so a future config/ninebot.php migration has a
 * single place to change.
 */
final class RelayAuth
{
    /**
     * @return ErrorObject|null  null when the caller is authentic.
     */
    public static function verify(string $body, ?string $bearerToken, ?string $signature): ?ErrorObject
    {
        $providedToken = (string) $bearerToken;

        // NO compiled-in fallback: the previous default was the same string
        // that ships inside the relay APK (any APK teardown yields it), so the
        // "fallback" was effectively the production secret. The env var is now
        // mandatory; a missing primary secret fails CLOSED, loudly.
        $pairs = [[
            (string) env('BMS_RELAY_TOKEN', ''),
            (string) env('BMS_RELAY_HMAC_SECRET', ''),
        ]];
        if ($pairs[0][0] === '' || $pairs[0][1] === '') {
            Log::error('BMS_RELAY_HMAC_SECRET is not configured — rejecting all relay traffic');
            return new ErrorObject(
                'server_error',
                'relay_auth_misconfigured',
                'Relay HMAC secret is not configured on the server',
            );
        }

        // A next pair permits a zero-downtime APK credential migration. Keep
        // token and HMAC paired: accepting their cross-product weakens the
        // second factor and makes it impossible to prove which generation is
        // actually in use. Remove NEXT immediately after rollout confirmation.
        $nextToken = (string) env('BMS_RELAY_TOKEN_NEXT', '');
        $nextSecret = (string) env('BMS_RELAY_HMAC_SECRET_NEXT', '');
        if ($nextToken !== '' && $nextSecret !== '') {
            $pairs[] = [$nextToken, $nextSecret];
        }

        $providedSig = (string) $signature;
        $ok = false;
        foreach ($pairs as [$token, $secret]) {
            if (hash_equals($token, $providedToken)
                && $providedSig !== ''
                && hash_equals(hash_hmac('sha256', $body, $secret), $providedSig)) {
                $ok = true;
                break;
            }
        }

        if (! $ok) {
            // Authentication diagnostics without exposing either credential.
            // This distinguishes a stale stored bearer token from a genuinely
            // different HMAC/body on unattended relay phones.
            $tokenMatches = [];
            $signatureMatches = [];
            foreach ($pairs as $index => [$token, $secret]) {
                $tokenMatches[$index] = $token !== '' && hash_equals($token, $providedToken);
                $signatureMatches[$index] = $providedSig !== ''
                    && hash_equals(hash_hmac('sha256', $body, $secret), $providedSig);
            }
            Log::warning('Relay authentication rejected', [
                'token_matches' => $tokenMatches,
                'signature_matches' => $signatureMatches,
                'provided_token_sha12' => substr(hash('sha256', $providedToken), 0, 12),
                'provided_signature_sha12' => substr(hash('sha256', $providedSig), 0, 12),
                'body_sha12' => substr(hash('sha256', $body), 0, 12),
                'body_bytes' => strlen($body),
            ]);
            return new ErrorObject(
                'authentication_error',
                'invalid_relay_signature',
                'HMAC signature mismatch — request rejected',
            );
        }

        return null;
    }

    /** Bearer-only compatibility for the multipart photo endpoint. */
    public static function acceptsBearer(?string $bearerToken): bool
    {
        $provided = (string) $bearerToken;
        foreach ([(string) env('BMS_RELAY_TOKEN', ''), (string) env('BMS_RELAY_TOKEN_NEXT', '')] as $token) {
            if ($token !== '' && hash_equals($token, $provided)) {
                return true;
            }
        }

        return false;
    }
}
