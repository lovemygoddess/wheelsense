<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * GET /api/tpms/captures — read compatible TPMS raw broadcast captures
 * (diagnostics only).
 *
 * 落地的原始 PDU 由本端点暴露给仪表盘/人工排查；Task #9 解析出结构化字段后，
 * 本端点可保留为「原始数据」视图或下线。支持 ?sensor= 与 ?limit= 过滤。
 */
class TpmsCaptureController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $sensor = $request->query('sensor');
        $limit = (int) ($request->query('limit', 200));
        $limit = max(1, min($limit, 1000));

        $q = DB::table('tpms_captures')->orderByDesc('id');
        if (is_string($sensor) && $sensor !== '') {
            $q->where('sensor_name', $sensor);
        }
        if ($request->query('mac')) {
            $q->where('mac', (string) $request->query('mac'));
        }
        $rows = $q->limit($limit)->get();

        return response()->json([
            'ok' => true,
            'count' => $rows->count(),
            'captures' => $rows,
        ]);
    }
}
