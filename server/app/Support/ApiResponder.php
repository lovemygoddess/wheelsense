<?php

namespace App\Support;

use App\ValueObjects\Api\ApiResponse;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\JsonResponse;

final class ApiResponder
{
    /**
     * Silently drop malformed UTF-8 byte sequences (e.g. raw BLE bytes the
     * relay posts inside ble_status) instead of letting json_encode throw and
     * the endpoint return HTTP 500. Relay diagnostics are untrusted byte input.
     */
    private const JSON_FLAGS = JSON_INVALID_UTF8_IGNORE;

    /**
     * @param  array<string, mixed>  $meta
     */
    public static function success(string $rootKey, array $resource, int $status = 200, array $meta = []): JsonResponse
    {
        return response()->json((new ApiResponse(rootKey: $rootKey, data: $resource, meta: $meta))->toArray(), $status, [], self::JSON_FLAGS);
    }

    /**
     * @param  array<int, array<string, mixed>>  $resources
     * @param  array<string, mixed>  $meta
     */
    public static function collection(string $rootKey, array $resources, int $status = 200, array $meta = []): JsonResponse
    {
        return response()->json((new ApiResponse(rootKey: $rootKey, data: $resources, meta: $meta))->toArray(), $status, [], self::JSON_FLAGS);
    }

    public static function noContent(): JsonResponse
    {
        return response()->json([], 204, [], self::JSON_FLAGS);
    }

    /**
     * @param  array<string, mixed>  $meta  optional extra payload (e.g.
     *         ['errors' => $fieldErrors] for validation detail). Extra args
     *         were previously accepted by PHP but silently dropped — the
     *         mobile client never received field-level validation messages.
     */
    public static function error(ErrorObject $error, int $status, array $meta = []): JsonResponse
    {
        return response()->json((new ApiResponse(errors: [$error], meta: $meta))->toArray(), $status, [], self::JSON_FLAGS);
    }
}
