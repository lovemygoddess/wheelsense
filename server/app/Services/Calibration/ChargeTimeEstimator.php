<?php

namespace App\Services\Calibration;

use App\Models\BatteryCalibration;
use App\Models\ChargeEvent;
use App\Models\DeviceSnapshot;
use Carbon\Carbon;

/**
 * Estimates "how long until full" while the scooter is currently charging.
 *
 * Model: for each historical full_charge event, plot the (voltage, time-from-start)
 * pair sequence. As voltage approaches the BMS full cutoff, time diverges (CV phase).
 * We fit a simple power-law in the form:
 *
 *     (v_max - v)^p  =  K / t           (or equivalently t(v) = K / (v_max - v)^p)
 *
 * which has t → ∞ as v → v_max. log of both sides gives a linear regression:
 *
 *     p * log(v_max - v) + log(t) = log(K)
 *
 * Inference at query time:
 *   - Find the best-fit K, p across all full events
 *   - At the current voltage, compute expected time-to-full
 *   - Subtract elapsed time since charging started
 *
 * Independent of charge cycle closure — each completed (full_charge=1) event
 * contributes its own sample curve, and we aggregate across events.
 */
class ChargeTimeEstimator
{
    public function estimate(
        string $deviceSn,
        float $currentVoltage,
        ?Carbon $currentSnapshotAt = null,
        ?array $liveBms = null,
        ?float $preferredSocPct = null,
        ?string $preferredSocSource = null,
    ): array {
        $cal = BatteryCalibration::query()->where('device_sn', $deviceSn)->first();
        $settings = new CalibrationSettings($cal);

        $bmsFull = $settings->bmsFullChargeVoltage();
        if ($bmsFull === null) {
            return [
                'supported' => false,
                'reason' => 'BMS 满充电压未配置，无法估算充电时间',
            ];
        }

        $currentSnapshotAt ??= Carbon::now();

        // Fresh protection-board current is the primary charging detector.
        // NineCLI's charge event is only the relay-offline fallback.
        $liveCharging = ! empty($liveBms['fresh'])
            && isset($liveBms['current_a'])
            && (float) $liveBms['current_a'] >= 0.3;

        $openEvent = ChargeEvent::query()
            ->where('device_sn', $deviceSn)
            ->whereNull('ended_at')
            ->orderByDesc('started_at')
            ->first();

        if (! $liveCharging && $openEvent === null) {
            return [
                'supported' => false,
                'reason' => '当前未在充电',
            ];
        }

        $elapsedMin = $openEvent !== null
            ? max(0, (int) Carbon::parse($openEvent->started_at)->diffInMinutes($currentSnapshotAt))
            : 0;

        // ---- Primary: energy-based estimate --------------------------------
        // remaining = (1 - SOC) × capacity ÷ charge_power, with a CV-taper
        // overhead factor. Structurally immune to the power-law's fatal flaw:
        // mixing training curves from different starting SOCs. Needs capacity
        // (calibrated) and a measured charge current; falls back to the
        // power-law model when either is missing.
        $energyResult = $this->estimateByEnergy(
            $deviceSn,
            $settings,
            $cal,
            $currentVoltage,
            $bmsFull,
            $liveBms,
            $preferredSocPct,
            $preferredSocSource,
        );
        if ($energyResult !== null) {
            $energyResult['elapsed_min'] ??= $elapsedMin;
            return $energyResult;
        }

        // ---- Fallback: power-law fit on historical full-charge events ------
        // Build training samples from historical full_charge events.
        $trainEvents = ChargeEvent::query()
            ->where('device_sn', $deviceSn)
            ->where('is_full_charge', true)
            ->whereNotNull('ended_at')
            ->orderBy('started_at')
            ->get();

        // 需要至少 2 次完整充电记录。单事件训练时，幂律模型 t=K/(v_max-v)^p 的
        // log-log 回归会被 CC 段大量近似线性点主导，K/p 严重失真（实测单事件
        // 在数据范围内误差就达 3 倍，外推到满充段误差 25 倍，曾预测出 123 小时）。
        // 诚实返回"不可用"远好于显示荒谬的剩余时间。
        if ($trainEvents->count() < 2) {
            return [
                'supported' => false,
                'reason' => '完整充电记录不足 2 次，充电时间估算暂不可靠（需至少 2 次充满到 100% 的记录）',
            ];
        }

        $samples = []; // [[log_vgap, log_t], ...]
        foreach ($trainEvents as $e) {
            // Pull all charging=1 snapshots in [started_at, ended_at] and compute
            // (voltage, minutes-from-start).
            $snaps = DeviceSnapshot::query()
                ->where('device_id', $e->device_sn === $deviceSn ? $this->deviceId($deviceSn) : null)
                ->where('charging_state', 1)
                ->whereNotNull('bms_voltage')
                ->whereBetween('created_at', [$e->started_at, $e->ended_at])
                ->orderBy('created_at')
                ->get(['created_at', 'bms_voltage']);
            if ($snaps->isEmpty()) continue;

            $startTs = Carbon::parse($e->started_at);
            foreach ($snaps as $s) {
                $tMin = max(0.5, (int) $startTs->diffInMinutes(Carbon::parse($s->created_at)));
                $v = (float) $s->bms_voltage;
                $vgap = max(0.05, $bmsFull - $v); // strictly positive; protects log()
                $samples[] = [log($vgap), log($tMin)];
            }
        }

        if (count($samples) < 5) {
            return [
                'supported' => false,
                'reason' => '训练样本不足（< 5 个电压-时间点）',
            ];
        }

        // Linear regression: log(t) = log(K) - p * log(vgap)
        //   y = a + b*x  where y=log(t), x=log(vgap), a=log(K), b=-p
        [$a, $b] = $this->linearRegression($samples);
        $K = exp($a);
        $p = -$b;

        // The regression t(v) = K / (v_max - v)^p predicts "minutes from charge
        // START until voltage v is reached" — not the remaining time. The correct
        // remaining time is the model's predicted TOTAL duration (v at full,
        // vgap clamped to 0.05) minus the already-elapsed minutes. The old code
        // computed t(v_current) - elapsed, which is ≈ 0 by construction.
        if ($p < 0.1) {
            return [
                'supported' => false,
                'reason' => '拟合退化（功率指数 p < 0.1），训练数据不足或电压序列异常',
            ];
        }

        $totalExpectedMin = $K / pow(0.05, $p);
        $vgapCurrent = max(0.05, $bmsFull - $currentVoltage);
        if ($vgapCurrent <= 0.05) {
            // Already at full voltage.
            $remainingMin = 0;
        } else {
            // Still below full voltage → at least 1 minute to go (never lie "已满").
            $remainingMin = max(1, (int) round($totalExpectedMin - $elapsedMin));
        }

        // 硬上限：幂律模型在 vgap→0 外推发散，训练样本未覆盖满充段时会预测出
        // 荒谬的大值（曾出现 123 小时）。剩余时间超过 12 小时即判定为不可靠，
        // 返回不可用而非误导性的天文数字。
        $MAX_REASONABLE_REMAINING_MIN = 12 * 60;
        if ($remainingMin > $MAX_REASONABLE_REMAINING_MIN) {
            return [
                'supported' => false,
                'reason' => '估算超出合理范围（训练样本不足，充电时间模型失真）',
                'remaining_min_raw' => $remainingMin, // 原始值仅用于调试
            ];
        }

        // Variance → confidence (simple heuristic on log-space residuals).
        $confidence = $this->confidenceFromResiduals($samples, $a, $b);

        return [
            'supported' => true,
            'method' => 'power_law',
            'remaining_min' => $remainingMin,
            'elapsed_min' => $elapsedMin,
            'predicted_total_min' => isset($totalExpectedMin) ? (int) round($totalExpectedMin) : null,
            'current_voltage' => $currentVoltage,
            'bms_full_charge_voltage' => $bmsFull,
            'training_events' => count($trainEvents),
            'training_samples' => count($samples),
            'fit_p' => round($p, 3),
            'fit_K' => round($K, 2),
            'confidence' => round($confidence, 4),
            'note' => $remainingMin > 600 ? '估算超过 10 小时，可能拟合不充分' : null,
        ];
    }

    /** Resolve device_id from sn (avoids passing Device through the signature). */
    private function deviceId(string $deviceSn): int
    {
        return (int) \App\Models\Device::query()->where('sn', $deviceSn)->value('id');
    }

    /**
     * Energy-based remaining-time estimate.
     *
     *   remaining_min ≈ (1 - SOC) × capacity_wh ÷ (V × I_eff) × 60 × cv_factor
     *
     * Source preference:
     *   1. live board remaining/total Ah plus its measured charging current;
     *   2. the dashboard's already-arbitrated BMS/voltage SOC;
     *   3. calibrated voltage curve as the final energy fallback.
     *
     * Vendor SOC is deliberately excluded because a non-original battery may
     * report 100% while the board still has meaningful charge remaining.
     *
     * cv_factor compensates the constant-voltage taper near full (current
     * decays, so the last ~10% of energy takes disproportionately long).
     *
     * Returns null when required inputs are missing (caller falls back to
     * the power-law model).
     */
    private function estimateByEnergy(
        string $deviceSn,
        CalibrationSettings $settings,
        ?BatteryCalibration $cal,
        float $currentVoltage,
        float $bmsFull,
        ?array $liveBms,
        ?float $preferredSocPct,
        ?string $preferredSocSource,
    ): ?array {
        $capacityWh = $cal?->capacity_wh_estimate !== null ? (float) $cal->capacity_wh_estimate : null;
        $configuredCurrentA = $settings->effectiveChargeCurrentA();

        $liveCurrentA = ! empty($liveBms['fresh']) && isset($liveBms['current_a'])
            ? (float) $liveBms['current_a']
            : null;
        // ANT board convention in this project: positive = charging.
        $chargeCurrentA = $liveCurrentA !== null && $liveCurrentA >= 0.3
            ? $liveCurrentA
            : $configuredCurrentA;
        if ($chargeCurrentA === null || $chargeCurrentA <= 0) {
            return null;
        }

        $liveTotalAh = ! empty($liveBms['fresh']) && isset($liveBms['capacity_total_ah'])
            ? (float) $liveBms['capacity_total_ah']
            : null;
        $liveRemainingAh = ! empty($liveBms['fresh']) && isset($liveBms['capacity_remaining_ah'])
            ? (float) $liveBms['capacity_remaining_ah']
            : null;
        $liveCapacityInconsistent = false;
        if ($liveTotalAh !== null
            && $liveTotalAh > 0
            && $liveRemainingAh !== null
            && $liveRemainingAh >= 0
            && $liveRemainingAh <= $liveTotalAh * 1.02
        ) {
            $remainingAh = max(0.0, $liveTotalAh - min($liveRemainingAh, $liveTotalAh));
            $soc = min(1.0, max(0.0, $liveRemainingAh / $liveTotalAh));
            // Some boards clamp the coulomb counter to 100% before the voltage
            // reaches the configured charger cutoff. Do not turn that mismatch
            // into "已满"/1 minute; fall through to the voltage curve instead.
            $liveCapacityInconsistent = $currentVoltage < $bmsFull - 0.30
                && $remainingAh < $liveTotalAh * 0.005;

            if (! $liveCapacityInconsistent) {
                $taperFactor = $this->chargeTaperFactor($soc);
                $remainingMin = (int) round($remainingAh / $chargeCurrentA * 60.0 * $taperFactor);

                if ($currentVoltage < $bmsFull - 0.05 && $remainingAh > 0.02) {
                    $remainingMin = max(2, $remainingMin);
                }

                return $this->validatedEnergyResult([
                    'supported' => true,
                    'method' => 'bms_capacity',
                    'remaining_min' => $remainingMin,
                    'current_voltage' => $currentVoltage,
                    'bms_full_charge_voltage' => $bmsFull,
                    'soc_used' => round($soc * 100, 1),
                    'soc_source' => 'bms_capacity',
                    'capacity_total_ah' => round($liveTotalAh, 3),
                    'capacity_remaining_ah' => round($liveRemainingAh, 3),
                    'capacity_to_fill_ah' => round($remainingAh, 3),
                    'charge_current_a' => round($chargeCurrentA, 2),
                    'charge_power_w' => round($currentVoltage * $chargeCurrentA, 1),
                    'cv_factor' => $taperFactor,
                    'confidence' => 0.9,
                    'note' => '按保护板剩余容量、实时充电电流并计入末段降流估算',
                ]);
            }
        }

        if ($capacityWh === null || $capacityWh <= 0) {
            return null;
        }

        $socSource = null;
        $soc = null;
        if ($preferredSocPct !== null
            && in_array($preferredSocSource, ['bms', 'voltage'], true)
            && ! ($preferredSocSource === 'bms' && $liveCapacityInconsistent)
        ) {
            $soc = max(0.0, min(1.0, $preferredSocPct / 100.0));
            $socSource = $preferredSocSource === 'bms' ? 'bms_soc' : 'voltage_soc';
        } elseif (! empty($cal?->soc_curve_params)) {
            $bucket = $settings->tempBucket(null);
            $params = $cal->soc_curve_params[$bucket] ?? ($cal->soc_curve_params['normal'] ?? null)
                ?? (is_array($cal->soc_curve_params) ? reset($cal->soc_curve_params) : null);
            $anchors = is_array($params) ? ($params['anchors'] ?? null) : null;
            if (is_array($anchors) && $anchors !== []) {
                $fitter = new SocCurveFitter();
                $soc = max(0.0, min(1.0, $fitter->interpolate($anchors, $currentVoltage)));
                $socSource = 'curve_under_charge_inflated';
            }
        }
        if ($soc === null) {
            return null;
        }

        // Charge power at the present terminal voltage (CC phase).
        $powerW = max(1.0, $currentVoltage * $chargeCurrentA);

        // CV taper overhead: below 80% the charge is almost pure CC (cheap);
        // approaching full the taper dominates.
        $cvFactor = $this->chargeTaperFactor($soc);

        $remainingWh = max(0.0, (1.0 - $soc) * $capacityWh);
        $remainingMin = (int) round($remainingWh / $powerW * 60.0 * $cvFactor);

        if ($currentVoltage < $bmsFull - 0.05) {
            $remainingMin = max(1, $remainingMin); // never claim "已满" below full voltage
        }

        return $this->validatedEnergyResult([
            'supported' => true,
            'method' => 'energy',
            'remaining_min' => $remainingMin,
            'current_voltage' => $currentVoltage,
            'bms_full_charge_voltage' => $bmsFull,
            'soc_used' => round($soc * 100, 1),
            'soc_source' => $socSource,
            'capacity_wh' => $capacityWh,
            'charge_current_a' => round($chargeCurrentA, 2),
            'charge_power_w' => round($powerW, 1),
            'cv_factor' => $cvFactor,
            'confidence' => $socSource === 'bms_soc' ? 0.78 : 0.55,
            'note' => match ($socSource) {
                'bms_soc' => '按保护板电量与充电电流估算',
                'voltage_soc' => '按电压电量曲线估算，充电末段误差可能较大',
                default => '充电中端电压含 I×R 抬升，实际剩余时间可能更长',
            },
        ]);
    }

    private function chargeTaperFactor(float $soc): float
    {
        return match (true) {
            $soc < 0.80 => 1.08,
            $soc < 0.90 => 1.15,
            $soc < 0.95 => 1.28,
            default => 1.45,
        };
    }

    /** @param array<string, mixed> $result */
    private function validatedEnergyResult(array $result): array
    {
        $remainingMin = (int) ($result['remaining_min'] ?? 0);
        if ($remainingMin > 12 * 60) {
            return [
                'supported' => false,
                'reason' => '能量法估算超出合理范围（容量或电流先验可能不准）',
                'remaining_min_raw' => $remainingMin,
            ];
        }

        return $result;
    }

    /**
     * Closed-form least squares on (x=log(vgap), y=log(t)).
     *
     * @param array<int, array{0: float, 1: float}> $samples
     * @return array{0: float, 1: float}  [intercept, slope]
     */
    private function linearRegression(array $samples): array
    {
        $n = count($samples);
        $sx = 0; $sy = 0; $sxx = 0; $sxy = 0;
        foreach ($samples as [$x, $y]) {
            $sx += $x; $sy += $y; $sxx += $x * $x; $sxy += $x * $y;
        }
        $den = $n * $sxx - $sx * $sx;
        if (abs($den) < 1e-9) return [1.0, 0.0];
        $b = ($n * $sxy - $sx * $sy) / $den;
        $a = ($sy - $b * $sx) / $n;
        return [$a, $b];
    }

    /** R² of the linear fit; 0..1 confidence. */
    private function confidenceFromResiduals(array $samples, float $a, float $b): float
    {
        $yMean = array_sum(array_column($samples, 1)) / count($samples);
        $ssRes = 0; $ssTot = 0;
        foreach ($samples as [$x, $y]) {
            $pred = $a + $b * $x;
            $ssRes += ($y - $pred) ** 2;
            $ssTot += ($y - $yMean) ** 2;
        }
        if ($ssTot < 1e-9) return 1.0;
        $r2 = max(0.0, 1.0 - $ssRes / $ssTot);
        return $r2;
    }
}
