<?php

namespace App\Services;

use Illuminate\Http\Client\Factory as HttpFactory;

class NinebotApiService
{
    private const string DEFAULT_BASE_URL = 'http://127.0.0.1:18009';

    /** Max retries for transient network failures (EOF, reset, timeout). */
    private const int MAX_RETRIES = 2;

    /** Backoff between retries in milliseconds. */
    private const int RETRY_BACKOFF_MS = 500;

    public function __construct(private readonly HttpFactory $http) {}

    public function login(string $account, string $password): array
    {
        return $this->request('POST', '/auth/login', [
            'account' => $account,
            'password' => $password,
        ]);
    }

    public function loginCode(string $account, ?string $code = null): array
    {
        return $code === null
            ? $this->request('POST', '/auth/login-code', ['account' => $account])
            : $this->request('POST', '/auth/login-code/consume', ['account' => $account, 'code' => $code]);
    }

    public function whoami(): array
    {
        return $this->request('GET', '/whoami');
    }

    public function vehicles(): array
    {
        return $this->request('GET', '/vehicles');
    }

    public function status(string $sn): array
    {
        return $this->request('GET', '/vehicles/'.rawurlencode($sn).'/status');
    }

    public function battery(string $sn): array
    {
        return $this->request('GET', '/vehicles/'.rawurlencode($sn).'/battery');
    }

    public function travel(string $sn, ?string $month = null): array
    {
        return $this->request('GET', '/vehicles/'.rawurlencode($sn).'/travel', array_filter(['month' => $month]));
    }

    /**
     * Single-ride detail with full GPS trail + 200+ per-point speed samples.
     *
     * **URL must be path-parameter**, not `?detail=...` or `?id=...`:
     *   GET /vehicles/{sn}/travel/{travel_id}
     *
     * The 4th column of each `trail` semicolon-segment is the instantaneous
     * speed in **mph** (miles per hour, signed; can briefly go negative —
     * see SpeedAnalyzer for validation and analysis).
     */
    public function travelDetail(string $sn, string $travelId): array
    {
        return $this->request('GET', '/vehicles/'.rawurlencode($sn).'/travel/'.rawurlencode($travelId));
    }

    public function command(string $sn, string $action): array
    {
        $paths = [
            'engine-start' => 'engine/start',
            'engine-stop' => 'engine/stop',
            'buck' => 'buck',
            'bell' => 'bell',
        ];

        if (! isset($paths[$action])) {
            return [
                'ok' => false,
                'error' => [
                    'code' => 'unsupported_action',
                    'message' => 'Unsupported vehicle action.',
                ],
            ];
        }

        return $this->request('POST', '/vehicles/'.rawurlencode($sn).'/'.$paths[$action]);
    }

    /**
     * Determine if an upstream error is a transient network failure that
     * is safe to retry (EOF, connection reset, timeout, etc.).
     */
    private function isTransientError(string $message): bool
    {
        $lower = strtolower($message);
        $patterns = [
            ': eof',                    // Go: unexpected end of stream
            'connection reset',          // TCP RST
            'connection refused',        // TCP connect refused (ninecli down)
            'timeout',                   // Request timeout
            'no such host',              // DNS failure
            'network is unreachable',    // No route
            'temporary failure',         // DNS lookup temporary failure
            'upstream_unreachable',      // Our own structured code
            'connection_exception',      // Laravel ConnectionException marker
        ];
        foreach ($patterns as $p) {
            if (str_contains($lower, $p)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Sanitize a raw upstream (Go/ninecli) error message so the UI doesn't
     * show full URLs, Go internals, or panic traces. Maps known network
     * errors to friendly Chinese messages.
     */
    private function sanitizeErrorMessage(string $raw, string $endpoint): string
    {
        $lower = strtolower($raw);

        // Connection-level errors
        if (str_contains($lower, 'connection refused') || str_contains($lower, 'upstream_unreachable')) {
            return '无法连接 NineCLI 兼容桥接，请确认 NINECLI_BASE_URL 和独立服务状态。';
        }

        // Transient network errors from the upstream cloud
        if (str_contains($lower, ': eof') || str_contains($lower, 'connection reset')) {
            return '九号云端网络连接中断（EOF），请稍后重试。';
        }

        if (str_contains($lower, 'timeout') || str_contains($lower, 'deadline exceeded')) {
            return '九号云端请求超时，请稍后重试。';
        }

        if (str_contains($lower, 'no such host') || str_contains($lower, 'temporary failure')) {
            return '九号云端域名解析失败，请检查网络连接。';
        }

        if (str_contains($lower, 'tls') || str_contains($lower, 'certificate')) {
            return '九号云端安全连接失败，请稍后重试。';
        }

        // Generic fallback: strip URLs and technical details but keep
        // the human-readable prefix if present.
        $clean = preg_replace('#https?://\S+#', '***', $raw);
        $clean = preg_replace('#\s+(do:|Post|Get)\s+#', ' ', $clean);
        // Limit to a reasonable length
        if (mb_strlen($clean) > 120) {
            $clean = mb_substr($clean, 0, 120) . '…';
        }
        return trim($clean) !== '' ? trim($clean) : 'ninecli 请求失败，请稍后重试。';
    }

    private function request(string $method, string $path, array $payload = []): array
    {
        $baseUrl = rtrim((string) env('NINECLI_BASE_URL', self::DEFAULT_BASE_URL), '/');
        $token = (string) env('NINECLI_SERVICE_TOKEN', '');
        $endpoint = $method . ' ' . $path;

        $lastError = null;

        for ($attempt = 0; $attempt <= self::MAX_RETRIES; $attempt++) {
            if ($attempt > 0) {
                usleep(self::RETRY_BACKOFF_MS * 1000);
            }

            // Hard timeouts: the default 30s could hang the single-threaded
            // `artisan serve` worker (and with it the WHOLE dashboard) when
            // ninecli or the upstream cloud stalls. 8s/3s × (1+2 retries)
            // bounds worst case at ~26s, well under the 120s queue-job timeout.
            $request = $this->http->acceptJson()->timeout(8)->connectTimeout(3);
            if ($token !== '') {
                $request = $request->withToken($token);
            }

            try {
                $response = match ($method) {
                    'GET' => $request->get($baseUrl.$path, $payload),
                    'POST' => $request->post($baseUrl.$path, $payload),
                    default => throw new \InvalidArgumentException('Unsupported method.'),
                };
            } catch (\Illuminate\Http\Client\ConnectionException $e) {
                // ninecli process down / port closed → structured error instead of
                // an uncaught exception that surfaces as a bare HTTP 500.
                $lastError = [
                    'ok' => false,
                    'error' => [
                        'code' => 'upstream_unreachable',
                        'message' => $this->sanitizeErrorMessage($e->getMessage(), $endpoint),
                    ],
                ];

                // Don't retry if ninecli itself is down (connection refused is immediate)
                if (str_contains(strtolower($e->getMessage()), 'connection refused')) {
                    return $lastError;
                }

                // Retry transient connection errors (EOF, reset, timeout)
                continue;
            }

            $data = $response->json();

            if (! is_array($data)) {
                return [
                    'ok' => false,
                    'error' => [
                        'code' => 'invalid_response',
                        'message' => 'ninecli returned an invalid response.',
                    ],
                ];
            }

            // Check if the upstream ninecli returned an error that looks transient
            if (($data['ok'] ?? false) === true) {
                return $data; // success — no retry needed
            }

            $errMsg = (string) ($data['error']['message'] ?? '');
            if ($errMsg !== '' && $this->isTransientError($errMsg) && $attempt < self::MAX_RETRIES) {
                $lastError = [
                    'ok' => false,
                    'error' => [
                        'code' => (string) ($data['error']['code'] ?? 'upstream_error'),
                        'message' => $this->sanitizeErrorMessage($errMsg, $endpoint),
                    ],
                ];
                continue; // retry
            }

            // Non-transient error — sanitize and return immediately
            if ($errMsg !== '') {
                $data['error']['message'] = $this->sanitizeErrorMessage($errMsg, $endpoint);
            }
            return $data;
        }

        // All retries exhausted — return the last error
        return $lastError ?? [
            'ok' => false,
            'error' => [
                'code' => 'upstream_unreachable',
                'message' => '无法连接 NineCLI 兼容桥接，请确认 NINECLI_BASE_URL 和独立服务状态。',
            ],
        ];
    }
}
