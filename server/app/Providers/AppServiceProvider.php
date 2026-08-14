<?php

namespace App\Providers;

use App\Models\DeviceRideHistory;
use App\Observers\DeviceRideHistoryObserver;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(\App\Services\EzvizApiService::class, function ($app) {
            return new \App\Services\EzvizApiService(
                $app['config']->get('services.ezviz.app_key', ''),
                $app['config']->get('services.ezviz.app_secret', ''),
            );
        });
    }

    public function boot(): void
    {
        DeviceRideHistory::observe(DeviceRideHistoryObserver::class);
    }
}
