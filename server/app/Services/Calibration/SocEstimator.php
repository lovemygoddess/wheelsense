<?php

namespace App\Services\Calibration;

use App\Models\BatteryCalibration;
use Illuminate\Support\Carbon;

/**
 * Live SOC query API used by the home page.
 *
 * Returns the calibrated SOC estimate, the vendor SOC for comparison,
 * confidence (0..1), and effective sample count — modelled to look
 * similar to the Ninebot app's "预估准确率 91% / 有效样本 38 次".
 */
class SocEstimator
{
    public function __construct(
        private readonly SocCurveFitter $fitter,
        private readonly TrustedConsumptionService $trustedConsumption,
    ) {}

    /**
     * @return array{
     *     calibrated: float|null,
     *     voltage_soc: float|null,
     *     bms_soc_pct: float|null,
     *     soc_source: string,
     *     vendor: float|null,
     *     confidence: float,
     *     sample_count: int,
     *     curve_version: int,
     *     effective_endurance_km: float|null,
     *     wh_per_km: float|null,
     *     note: ?string
     * }
     */
    public function estimate(string $deviceSn, ?float $voltage, ?float $temp, ?float $vendorSoc, ?float $bmsSoc = null): array
    {
        $cal = BatteryCalibration::query()->where('device_sn', $deviceSn)->first();
        $settings = new CalibrationSettings($cal);
        $trusted = $this->trustedConsumption->estimate($deviceSn);
        $whPerKm = $trusted['wh_per_km'];
        $capacityWh = $cal?->capacity_wh_estimate !== null
            ? (float) $cal->capacity_wh_estimate
            : $cal?->priorCapacityWh();

        // 保护板库仑 SoC（relay 实时帧的 soc_pct，∫I·dt 真实计量）：
        // 单调性好、不随负载跳变，是本包电池环最准的口径。仅当 relay 实时帧
        // 可用（fresh）时由调用方传入，否则回退电压法。
        $bmsValid = $bmsSoc !== null && $bmsSoc >= 0 && $bmsSoc <= 100;
        $bmsSocPct = $bmsValid ? round((float) $bmsSoc, 1) : null;
        $socSource = $bmsValid ? 'bms' : 'voltage';

        if ($voltage === null) {
            // 续航分子：保护板 SoC 优先，否则无（回退厂商）。
            $endurance = null;
            if ($bmsValid && $capacityWh !== null && $capacityWh > 0 && $whPerKm) {
                $endurance = (($bmsSoc / 100) * $capacityWh) / $whPerKm;
            }
            return [
                'calibrated' => null,
                'voltage_soc' => null,
                'bms_soc_pct' => $bmsSocPct,
                'soc_source' => $socSource,
                'vendor' => $vendorSoc,
                'confidence' => 0.0,
                'sample_count' => 0,
                'curve_version' => 0,
                'effective_endurance_km' => $endurance !== null ? round($endurance, 1) : null,
                'wh_per_km' => $whPerKm,
                'note' => $bmsValid ? '电压未上报，使用保护板 SOC' : '电压未上报，使用厂商 SOC',
            ];
        }

        // 电压法 SOC（默认 14S 高压 NMC 静态 OCV 表）——回退口径。
        // vendor dump_energy 可能按原厂电池标定，因此仅作参考。
        $voltageSoc = VoltageSocCurve::socFromPackVoltage((float) $voltage);

        // 续航分子：保护板库仑 SoC 优先，否则电压法 SOC。纯电压法在高电压区
        // 饱和（54.6V 即输出 100%）导致满电续航虚高；保护板 SoC 不随负载饱和。
        $effSoc = $bmsValid ? (float) $bmsSoc / 100 : $voltageSoc;
        $endurance = null;
        if ($effSoc > 0 && $capacityWh !== null && $capacityWh > 0 && $whPerKm) {
            $endurance = ($effSoc * $capacityWh) / $whPerKm;
        }

        if ($cal === null || ! $cal->is_calibrated || empty($cal->soc_curve_params)) {
            return [
                'calibrated' => null,
                'voltage_soc' => round($voltageSoc * 100, 1),
                'bms_soc_pct' => $bmsSocPct,
                'soc_source' => $socSource,
                'vendor' => $vendorSoc,
                'confidence' => (float) ($cal?->confidence_soc ?? 0),
                'sample_count' => (int) ($cal?->total_calibration_samples ?? 0),
                'curve_version' => (int) ($cal?->soc_curve_version ?? 0),
                'effective_endurance_km' => $endurance !== null ? round($endurance, 1) : null,
                'wh_per_km' => $whPerKm,
                'note' => $endurance !== null ? null : '缺少可信容量或能耗参数',
            ];
        }

        $bucket = $settings->tempBucket($temp);
        $params = $cal->soc_curve_params[$bucket] ?? ($cal->soc_curve_params['normal'] ?? null);

        if ($params === null) {
            return [
                'calibrated' => null,
                'voltage_soc' => round($voltageSoc * 100, 1),
                'bms_soc_pct' => $bmsSocPct,
                'soc_source' => $socSource,
                'vendor' => $vendorSoc,
                'confidence' => 0.0,
                'sample_count' => 0,
                'curve_version' => (int) $cal->soc_curve_version,
                'effective_endurance_km' => $endurance !== null ? round($endurance, 1) : null,
                'wh_per_km' => $whPerKm,
                'note' => "温度桶 {$bucket} 缺曲线",
            ];
        }

        $anchors = $params['anchors'] ?? [];
        $soc = $this->fitter->interpolate($anchors, (float) $voltage);
        $soc = max(0.0, min(1.0, $soc));

        // Confidence: combine stored variance, sample count, and freshness.
        $variance = (float) ($params['variance'] ?? 0);
        $n = (int) ($params['n'] ?? 0);
        // Positive days since last calibration (Carbon 3 diffInDays is signed;
        // now()->diffInDays($past) would be negative and INCREASE confidence
        // as the curve gets staler — the opposite of the intent).
        $daysSince = $cal->last_calibrated_at
            ? (int) Carbon::parse($cal->last_calibrated_at)->diffInDays(Carbon::now())
            : 999;
        $confidence = $this->sigmoid(
            0.45 * log(1 + $n) - 4.0 * $variance - 0.04 * $daysSince
        );

        return [
            'calibrated' => round($soc * 100, 1),
            'voltage_soc' => round($voltageSoc * 100, 1),
            'bms_soc_pct' => $bmsSocPct,
            'soc_source' => $socSource,
            'vendor' => $vendorSoc,
            'confidence' => $confidence,
            'sample_count' => $n,
            'curve_version' => (int) $cal->soc_curve_version,
            'effective_endurance_km' => $endurance !== null ? round($endurance, 1) : null,
            'wh_per_km' => $whPerKm,
            'note' => null,
        ];
    }

    private function sigmoid(float $x): float
    {
        return 1.0 / (1.0 + exp(-$x));
    }
}
