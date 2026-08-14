<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // API routes need session + encrypted cookies so the dashboard.gate middleware
        // can persist the unlock state across requests.
        $middleware->api(prepend: [
            \Illuminate\Cookie\Middleware\EncryptCookies::class,
            \Illuminate\Session\Middleware\StartSession::class,
        ]);
        // Caddy reverse proxy (loopback) terminates TLS — honor its X-Forwarded-*
        // headers so rate limiting and logs see the real client IP. Direct LAN
        // hits on :8000 are unaffected (their peer is not 127.0.0.1).
        $middleware->trustProxies(at: '127.0.0.1');
        $middleware->alias([
            'dashboard.gate' => \App\Http\Middleware\DashboardAuthGate::class,
            'login.lockout' => \App\Http\Middleware\LoginBruteForceGuard::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
    })
    ->create();
