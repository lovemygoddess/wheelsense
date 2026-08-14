<?php

/**
 * Router script for PHP's built-in server (`php -S 0.0.0.0:8000 -t public router.php`).
 *
 * This file lives in version control on purpose. It used to exist only on the
 * production box, untracked and unreviewed, while being the very first thing
 * every public request touches — including the path-traversal gate below.
 *
 * It has exactly two jobs:
 *   1. Decide whether the request maps to a real file inside public/ and, if
 *      so, let the built-in server send it (the traversal gate, below).
 *   2. Hand everything else to Laravel.
 * It deliberately makes no routing decisions of its own — see the note above
 * the dispatch at the bottom for why that used to be a bug.
 *
 * ── The traversal gate ──────────────────────────────────────────────
 *
 * `return false` hands the request back to the built-in server to serve as a
 * static file, so whatever passes the is_file() test below is served verbatim,
 * with no Laravel middleware in front of it. The old check was:
 *
 *     $candidate = $publicDir . $uri;
 *     if ($uri !== '/' && is_file($candidate)) { return false; }
 *
 * `$uri` is urldecode()d, so `%2e%2e` arrives as `..`, and string concatenation
 * does no normalisation. `GET /frontend/../../.env` therefore produced
 * `public/frontend/../../.env`, is_file() said yes, and the server returned the
 * entire .env — APP_KEY, BMS_RELAY_TOKEN and BMS_RELAY_HMAC_SECRET included.
 * A vulnerable implementation may expose environment files or arbitrary source.
 *
 * The only reason it was not live is that `public/frontend/` did not exist, so
 * is_file() failed on the missing intermediate directory. That is luck, not a
 * defence — and the 503 page this very file emits tells the operator to run
 * `npm run build`, which creates that directory and opens the hole.
 *
 * The fix is to resolve the path for real and require the result to stay under
 * public/. realpath() collapses `..` and follows symlinks, so the containment
 * test is done on the true target rather than on the requested spelling.
 *
 * NOTE: this assumes nothing inside public/ is a symlink pointing outside it.
 * `php artisan storage:link` would create exactly such a symlink; if that is
 * ever introduced, whitelist it explicitly rather than loosening this check.
 */

$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));

$publicDir = __DIR__ . '/public';
$publicReal = realpath($publicDir);

if ($publicReal === false) {
    http_response_code(500);
    echo 'Document root is missing.';
    return true;
}

if ($uri !== '/') {
    $candidate = realpath($publicDir . $uri);

    // Must resolve, must be a regular file, and must still be inside public/.
    // The DIRECTORY_SEPARATOR suffix stops a sibling `public-evil` directory
    // from passing a naive prefix match against the real public directory.
    if (
        $candidate !== false
        && str_starts_with($candidate, $publicReal . DIRECTORY_SEPARATOR)
        && is_file($candidate)
    ) {
        return false;
    }
}

// Everything that is not a real file under public/ goes to Laravel. Full stop.
//
// This used to be an allow-list — only /api, /up, /storage and /_debugbar were
// forwarded, and every other path was answered here with a copy of the SPA
// fallback. That silently killed the two server-rendered pages that actually
// work today: GET /relay/remote-control and GET /ezviz/player both returned
// "Frontend assets are not built" (HTTP 503) even though their routes and the
// dashboard.gate middleware may still be healthy; dynamic routes must always be
// dispatched through Laravel rather than mistaken for missing frontend assets.
//
// An allow-list here is the wrong shape: it has to be edited every time a
// route is added on the Laravel side, and forgetting to do so fails closed and
// invisibly. The SPA fallback is also already implemented in routes/web.php
// (the `/{any?}` catch-all, same 503 text), so keeping a second copy here only
// created a way for the two to disagree.
//
// Route registration order in web.php makes this safe: the explicit pages are
// declared before the catch-all, so they win, and anything unmatched still
// lands on the SPA fallback exactly as before.
require_once $publicDir . '/index.php';
return true;
