<?php

namespace App\Console\Commands;

use App\Services\DashboardAuth;
use Illuminate\Console\Command;

class SetDashboardPasswordCommand extends Command
{
    protected $signature = 'evtelemetry:set-dashboard-password {password?}';
    protected $description = 'Set or change the dashboard login password';

    public function handle(): int
    {
        $password = $this->argument('password');

        if ($password === null) {
            $password = $this->secret('Enter new dashboard password (min 8 characters)');
            if ($password === null || strlen($password) < 8) {
                $this->error('Password must be at least 8 characters.');
                return 1;
            }
            $confirm = $this->secret('Confirm password');
            if ($password !== $confirm) {
                $this->error('Passwords do not match.');
                return 1;
            }
        } elseif (strlen($password) < 8) {
            $this->error('Password must be at least 8 characters.');
            return 1;
        }

        DashboardAuth::set($password);
        $this->info('Dashboard password set successfully.');

        return 0;
    }
}
