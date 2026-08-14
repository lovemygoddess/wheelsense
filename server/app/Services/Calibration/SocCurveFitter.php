<?php

namespace App\Services\Calibration;

use App\Models\VoltageSample;

/**
 * Piecewise-linear / quadratic voltage → SOC fitter.
 *
 * For each temperature bucket, fits a simple monotonic curve using
 * least-squares piecewise linear interpolation with K knots on the
 * X axis (voltage). Output is a small set of (voltage, soc) anchor
 * pairs that lookups can linearly interpolate between.
 *
 * Intentionally simple — we don't need a full ML library.
 */
class SocCurveFitter
{
    private const KNOTS = 6; // 6 anchors across voltage range

    private ?float $voltageMin = null;
    private ?float $voltageMax = null;

    /**
     * @param  array{0: float, 1: float}|null  $voltageWindow  [cutoff, full] or null to disable clamping.
     */
    public function __construct(?array $voltageWindow = null)
    {
        if ($voltageWindow !== null) {
            $this->voltageMin = (float) $voltageWindow[0];
            $this->voltageMax = (float) $voltageWindow[1];
        }
    }

    public function setVoltageWindow(?array $window): void
    {
        $this->voltageMin = $window !== null ? (float) $window[0] : null;
        $this->voltageMax = $window !== null ? (float) $window[1] : null;
    }

    /**
     * Fit a curve from samples, return a serializable array of {voltage, soc} anchors,
     * plus variance (mean squared error) and sample count.
     *
     * @param  array<int, VoltageSample>|VoltageSample[]  $samples
     * @return array{v: array<int, array{voltage: float, soc: float}>, variance: float, n: int, rejected: int}|null
     *         Returns null if samples < min threshold.
     */
    public function fit(iterable $samples): ?array
    {
        $rows = [];
        $rejected = 0;
        foreach ($samples as $s) {
            $v = (float) $s->voltage;
            // BMS prior: drop samples outside the protected voltage window.
            if ($this->voltageMin !== null && $v < $this->voltageMin) { $rejected++; continue; }
            if ($this->voltageMax !== null && $v > $this->voltageMax) { $rejected++; continue; }
            $rows[] = ['v' => $v, 'soc' => (float) $s->implied_soc];
        }

        if (count($rows) < CalibrationConstants::MIN_VOLTAGE_SAMPLES_PER_BUCKET) {
            return null;
        }

        usort($rows, fn ($a, $b) => $a['v'] <=> $b['v']);

        $minV = $rows[0]['v'];
        $maxV = end($rows)['v'];
        if ($maxV - $minV < 0.5) {
            $res = $this->quadraticFit($rows, $rejected);
            return $res === null ? null : ['v' => $res['v'], 'variance' => $res['variance'], 'n' => $res['n'], 'rejected' => $res['rejected']];
        }

        // Quantile-based anchors: pick K evenly-spaced samples by RANK so that
        // every anchor's (voltage, soc) is from an actual observed point.
        // This avoids the bin-midpoint error where a single sample at the
        // extreme gets averaged with a far-away bucket mid.
        $anchors = [];
        $totalRows = count($rows);
        $knots = min(self::KNOTS, $totalRows);
        for ($i = 0; $i < $knots; $i++) {
            $idx = (int) round($i * ($totalRows - 1) / max(1, $knots - 1));
            $anchors[] = [
                'voltage' => (float) $rows[$idx]['v'],
                'soc' => (float) $rows[$idx]['soc'],
            ];
        }

        if (count($anchors) < 2) return null;

        // Voltage↑ must imply SOC↑. Quantile picks can land on noisy samples
        // that reverse the curve (observed: 51.9V→51% then 52.5V→38%).
        $anchors = $this->enforceMonotonicSoc($anchors);

        // Variance: for each sample, linear-interp predicted SOC vs actual.
        $sumSqErr = 0; $n = 0;
        foreach ($rows as $r) {
            $pred = $this->interpolate($anchors, $r['v']);
            $sumSqErr += ($pred - $r['soc']) ** 2;
            $n++;
        }
        $variance = $n > 0 ? $sumSqErr / $n : 0.0;

        return ['v' => $anchors, 'variance' => $variance, 'n' => $n, 'rejected' => $rejected];
    }

    private function quadraticFit(array $rows, int $rejected = 0): array
    {
        // Fit y = a*x^2 + b*x + c via normal equations.
        $Sx = 0; $Sx2 = 0; $Sx3 = 0; $Sx4 = 0;
        $Sy = 0; $Sxy = 0; $Sx2y = 0;
        $n = count($rows);
        foreach ($rows as $r) {
            $x = $r['v']; $y = $r['soc'];
            $x2 = $x * $x;
            $Sx += $x; $Sx2 += $x2; $Sx3 += $x2 * $x; $Sx4 += $x2 * $x2;
            $Sy += $y; $Sxy += $x * $y; $Sx2y += $x2 * $y;
        }
        // Crude closed-form (Gauss) — fine for small n.
        $A = [[$Sx4, $Sx3, $Sx2], [$Sx3, $Sx2, $Sx], [$Sx2, $Sx, $n]];
        $B = [$Sx2y, $Sxy, $Sy];
        [$a, $b, $c] = $this->solve3($A, $B) ?? [0, 0, $Sy / $n];

        // Evaluate anchors at min/mid/max voltage.
        $minV = $rows[0]['v']; $maxV = end($rows)['v'];
        $anchors = [];
        for ($i = 0; $i < self::KNOTS; $i++) {
            $v = $minV + ($maxV - $minV) * $i / (self::KNOTS - 1);
            $anchors[] = ['voltage' => $v, 'soc' => max(0, min(1, $a * $v * $v + $b * $v + $c))];
        }

        $anchors = $this->enforceMonotonicSoc($anchors);

        $sumSqErr = 0;
        foreach ($rows as $r) {
            $pred = $this->interpolate($anchors, $r['v']);
            $sumSqErr += ($pred - $r['soc']) ** 2;
        }

        return ['v' => $anchors, 'variance' => $n > 0 ? $sumSqErr / $n : 0.0, 'n' => $n, 'rejected' => $rejected];
    }

    /**
     * Isotonic (PAVA-style) pass: force SOC non-decreasing with voltage.
     * Collapses duplicate voltages to the max SOC seen at that voltage first.
     *
     * @param  list<array{voltage: float, soc: float}>  $anchors
     * @return list<array{voltage: float, soc: float}>
     */
    private function enforceMonotonicSoc(array $anchors): array
    {
        if (count($anchors) < 2) {
            return $anchors;
        }

        usort($anchors, fn ($a, $b) => $a['voltage'] <=> $b['voltage']);

        // Merge identical voltages keeping the higher SOC.
        $merged = [];
        foreach ($anchors as $a) {
            $v = round((float) $a['voltage'], 3);
            $soc = max(0.0, min(1.0, (float) $a['soc']));
            if ($merged !== [] && abs(end($merged)['voltage'] - $v) < 1e-6) {
                $idx = count($merged) - 1;
                $merged[$idx]['soc'] = max($merged[$idx]['soc'], $soc);
            } else {
                $merged[] = ['voltage' => $v, 'soc' => $soc];
            }
        }

        // Forward pass: each SOC >= previous.
        for ($i = 1; $i < count($merged); $i++) {
            if ($merged[$i]['soc'] < $merged[$i - 1]['soc']) {
                $merged[$i]['soc'] = $merged[$i - 1]['soc'];
            }
        }

        // Backward pass: pull plateaus down toward later higher-quality points
        // when a forward clamp created a long flat that overshoots the tail.
        // Keep simple: only ensure final point is the global max (already true
        // after forward) and clamp to [0,1].
        for ($i = 0; $i < count($merged); $i++) {
            $merged[$i]['soc'] = max(0.0, min(1.0, $merged[$i]['soc']));
        }

        return count($merged) >= 2 ? $merged : $anchors;
    }

    /**
     * Solve 3x3 linear system via Cramer's rule (good enough for tiny n).
     * @param array<int, array<int, float>> $A
     * @param array<int, float> $B
     * @return array<int, float>|null
     */
    private function solve3(array $A, array $B): ?array
    {
        $detA = $this->det3($A);
        if (abs($detA) < 1e-12) return null;

        // Cramer's rule: x_col = det(A with column `col` replaced by B) / det(A).
        // The old implementation ignored $col and returned det(A_0) for all three
        // unknowns (a=b=c), producing garbage quadratic fits when voltage span <0.5V.
        $solutions = [];
        for ($col = 0; $col < 3; $col++) {
            $M = $A;
            for ($row = 0; $row < 3; $row++) {
                $M[$row][$col] = $B[$row];
            }
            $solutions[$col] = $this->det3($M) / $detA;
        }
        return $solutions;
    }

    /**
     * Determinant of a 3x3 matrix.
     * @param array<int, array<int, float>> $M
     */
    private function det3(array $M): float
    {
        return $M[0][0]*($M[1][1]*$M[2][2] - $M[1][2]*$M[2][1])
             - $M[0][1]*($M[1][0]*$M[2][2] - $M[1][2]*$M[2][0])
             + $M[0][2]*($M[1][0]*$M[2][1] - $M[1][1]*$M[2][0]);
    }

    /**
     * Linearly interpolate SOC from a list of (voltage, soc) anchors.
     *
     * Clamps input voltage to the BMS-protected window if priors were injected
     * (no extrapolation below cutoff or above full voltage).
     *
     * @param array<int, array{voltage: float, soc: float}> $anchors
     */
    public function interpolate(array $anchors, float $voltage): float
    {
        if (empty($anchors)) return 0.0;

        // BMS prior: clamp input voltage to [vMin, vMax] before lookup.
        if ($this->voltageMin !== null && $voltage < $this->voltageMin) $voltage = $this->voltageMin;
        if ($this->voltageMax !== null && $voltage > $this->voltageMax) $voltage = $this->voltageMax;

        $sorted = $anchors;
        usort($sorted, fn ($a, $b) => $a['voltage'] <=> $b['voltage']);

        if ($voltage <= $sorted[0]['voltage']) return (float) $sorted[0]['soc'];
        if ($voltage >= end($sorted)['voltage']) return (float) end($sorted)['soc'];

        for ($i = 0; $i < count($sorted) - 1; $i++) {
            $a = $sorted[$i]; $b = $sorted[$i + 1];
            if ($voltage >= $a['voltage'] && $voltage <= $b['voltage']) {
                if (abs($b['voltage'] - $a['voltage']) < 1e-6) return (float) $a['soc'];
                $t = ($voltage - $a['voltage']) / ($b['voltage'] - $a['voltage']);
                return (float) ($a['soc'] + $t * ($b['soc'] - $a['soc']));
            }
        }
        return (float) end($sorted)['soc'];
    }
}
