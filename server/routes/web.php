<?php

use Illuminate\Support\Facades\Route;

// Embedded EZVIZ player — session-gated. The accessToken is handed over via
// the dashboard session (put there by GET /api/ezviz/live-url/{serial}), NOT
// via the URL query string: query tokens leak into browser history, server
// access logs and Referer headers. Legacy ?token=... URLs are rejected.
Route::get('/ezviz/player', function (\Illuminate\Http\Request $req) {
    $serial = (string) $req->query('serial', '');
    $handoff = $req->session()->get('ezviz_player');

    $token = is_array($handoff) ? ($handoff['token'] ?? null) : null;
    $sessionSerial = is_array($handoff) ? ($handoff['serial'] ?? null) : null;
    $issuedAt = is_array($handoff) ? (int) ($handoff['issued_at'] ?? 0) : 0;

    // Token hand-off is single-purpose and short-lived (10 min): the page is
    // expected to be opened right after live-url was fetched.
    $fresh = $issuedAt > 0 && (time() - $issuedAt) < 600;

    if (!$serial || !$token || !$fresh || $sessionSerial !== $serial) {
        abort(403, 'Player session expired — refetch the live URL.');
    }
    return response()->view('ezviz_player', ['token' => $token, 'serial' => $serial]);
})->middleware('dashboard.gate');

// Relay remote-control console — session-gated. Lets the owner issue shell /
// tap / swipe / key / screencap commands to the rooted relay phone and watch
// the results, without touching the SPA build.
Route::get('/relay/remote-control', function () {
    return response()->view('relay_remote_control');
})->middleware('dashboard.gate');

// Tire-pressure monitor — session-gated. Server-side decodes the latest
// JH.TPMS frames captured by the relay; no APK/SPA rebuild needed.
Route::get('/tpms', function () {
    return response()->view('tpms');
})->middleware('dashboard.gate');

// Serves the built SPA assets. `{path}` is `.*`, so it happily accepts `..`
// segments — and Laravel hands the route parameter over already URL-decoded,
// which means `%2e%2e` counts too. Concatenating that onto public_path() and
// trusting is_file() here would permit arbitrary-file reads, including
// environment files and application source. Keep the resolved-path containment
// check even when the frontend directory does not yet exist.
//
// So resolve the path for real and require it to stay under public/frontend.
// realpath() collapses `..` before the comparison, which is the whole point —
// checking the requested spelling instead of the resolved target is what
// every traversal bypass exploits.
//
// Mirrored in router.php, which is what actually fields these requests under
// `php -S`. Both are kept because either one can become the live path
// depending on how the app is served (public/.htaccess implies Apache too).
Route::get('/frontend/{path?}', function (?string $path = null) {
    $root = realpath(public_path('frontend'));
    abort_unless($root !== false, 404);

    $absolute = realpath(public_path('frontend/'.($path ?: 'index.html')));

    abort_unless(
        $absolute !== false
            && str_starts_with($absolute, $root.DIRECTORY_SEPARATOR)
            && is_file($absolute),
        404,
    );

    return response()->file($absolute);
})->where('path', '.*');

Route::get('/{any?}', function () {
    $path = public_path('frontend/index.html');

    // Plain text on purpose. abort(503, $message) would render Laravel's generic
    // error page, and with APP_DEBUG=false the message is dropped — the operator
    // would just see "Service Unavailable" with no idea that the fix is a build
    // step. router.php used to emit this same string before dispatch was handed
    // over to the framework; keeping it verbatim makes that hand-over a no-op
    // from the outside.
    if (! is_file($path)) {
        return response(
            'Frontend assets are not built. Run `npm run build` inside the frontend directory.',
            503,
        )->header('Content-Type', 'text/plain; charset=UTF-8');
    }

    return response()->file($path, [
        'Content-Type' => 'text/html; charset=UTF-8',
    ]);
})->where('any', '^(?!api|up|storage|frontend|ezviz).*$');
