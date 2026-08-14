<?php

namespace App\Http\Middleware;

use App\Services\DashboardAuth;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * LAN access gate: requires an authenticated session for protected routes.
 *
 * Authentication is via a custom password (stored in storage/app/dashboard-auth.json)
 * or the legacy DASHBOARD_TOKEN env value, established through POST /api/auth/login
 * which sets a session cookie.
 */
class DashboardAuthGate
{
    private const PUBLIC_PATHS = [
        'api/auth/login',
        'api/auth/status',
        'up',
    ];

    public function handle(Request $request, Closure $next): Response
    {
        $path = ltrim($request->path(), '/');

        if (in_array($path, self::PUBLIC_PATHS, true)) {
            return $next($request);
        }

        if (! DashboardAuth::isConfigured() && (string) env('DASHBOARD_TOKEN', '') === '') {
            return response()->json([
                'ok' => false,
                'errors' => [['code' => 'server_misconfigured', 'message' => '仪表盘密码未设置。请运行 php artisan evtelemetry:set-dashboard-password']],
            ], 503);
        }

        if (! $request->hasSession() || ! $request->session()->has('dashboard_unlocked')) {
            return response()->json([
                'ok' => false,
                'errors' => [['code' => 'unauthenticated', 'message' => '需要登录仪表盘']],
            ], 401);
        }

        return $next($request);
    }
}
