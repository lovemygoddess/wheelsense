<?php

namespace App\Services\Rides;

use App\Models\BatteryCalibration;
use App\Models\Device;
use App\Models\DeviceRideHistory;
use App\Services\Calibration\TrustedConsumptionService;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Carbon;

/** Persists ride energy independently of whether the rides screen is opened. */
class RideEnergyAttributionService
{
    public function __construct(
        private readonly BmsEnergyIntervalService $intervals,
        private readonly TrustedConsumptionService $trustedConsumption,
    ) {}

    /** @return Collection<int, DeviceRideHistory> */
    public function attributeMonth(Device $device, string $month): Collection
    {
        $rides = DeviceRideHistory::query()
            ->where('device_id', $device->id)
            ->where('month', $month)
            ->orderByDesc('started_at')
            ->get();
        if ($rides->isEmpty()) return $rides;

        $trusted = $this->trustedConsumption->estimate($device->sn);
        $trustedWhPerKm = $trusted['wh_per_km'];
        $monthStart = Carbon::createFromFormat('!Ym', $month)->startOfMonth();
        $voltageEstimator = VoltageRideEnergyEstimator::load(
            $device->id,
            $monthStart,
            $monthStart->copy()->endOfMonth(),
        );
        $cal = BatteryCalibration::query()->where('device_sn', $device->sn)->first();
        $capacityWh = $cal?->capacity_wh_estimate !== null
            ? (float) $cal->capacity_wh_estimate
            : (($cal?->nominal_voltage !== null && $cal?->nominal_capacity_ah !== null)
                ? (float) $cal->nominal_voltage * (float) $cal->nominal_capacity_ah
                : VoltageRideEnergyEstimator::FALLBACK_CAPACITY_WH);

        foreach ($rides as $ride) {
            $mileage = (float) $ride->mileage;
            $integrated = $this->intervals->energyForWindow(
                $device->sn,
                $ride->started_at,
                $ride->ended_at,
            );
            $whPerKm = $integrated['energy_wh'] !== null && $mileage > 0
                ? $integrated['energy_wh'] / $mileage
                : null;
            $lower = $trustedWhPerKm !== null ? max(15.0, $trustedWhPerKm * 0.50) : 15.0;
            $upper = $trustedWhPerKm !== null ? min(90.0, $trustedWhPerKm * 1.80) : 90.0;
            $usable = $mileage >= 2.0 && $whPerKm !== null && $whPerKm >= $lower && $whPerKm <= $upper;

            if ($usable) {
                $energy = [
                    'energy_wh' => $integrated['energy_wh'],
                    'wh_per_km' => round($whPerKm, 2),
                    'source' => 'bms_interval',
                ];
            } else {
                $voltage = $voltageEstimator->estimate($ride->started_at, $ride->ended_at, $capacityWh);
                $energy = $voltage !== null
                    ? [
                        'energy_wh' => $voltage['energy_wh'],
                        'wh_per_km' => $mileage > 0 ? round($voltage['energy_wh'] / $mileage, 2) : null,
                        'source' => $voltage['source'],
                    ]
                    : $this->trustedConsumption->fallbackForRide($mileage, $trustedWhPerKm);
            }

            $ride->forceFill([
                'energy' => $energy['energy_wh'] ?? 0,
                'energy_source' => $energy['source'],
                'energy_coverage' => $integrated['coverage'],
                'wh_per_km' => $energy['wh_per_km'],
            ])->saveQuietly();
        }

        return $rides->fresh();
    }
}
