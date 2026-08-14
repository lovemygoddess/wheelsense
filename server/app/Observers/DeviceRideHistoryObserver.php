<?php

namespace App\Observers;

use App\Jobs\AnalyzeRideSpeedJob;
use App\Models\DeviceRideHistory;

class DeviceRideHistoryObserver
{
    public function created(DeviceRideHistory $ride): void
    {
        // Synthetic / bootstrap rows have no upstream trail — mark skipped.
        if (preg_match('/^(CYC-|OUTLIER|test-|SYN|e2e-)/i', (string) $ride->ride_id)) {
            $ride->speed_analysis_status = 'skipped';
            $ride->analyzed_at = now();
            $ride->saveQuietly();
            return;
        }

        // SQLite may not return the column default on INSERT; the attribute
        // can be '' or null instead of 'pending'. Accept all three.
        if (in_array($ride->speed_analysis_status, ['pending', '', null], true)) {
            $ride->speed_analysis_status = 'processing';
            $ride->saveQuietly();
            AnalyzeRideSpeedJob::dispatch($ride->id);
        }
    }
}
