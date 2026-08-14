<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;

class GenerateRelayCredentialsCommand extends Command
{
    protected $signature = 'evtelemetry:relay-credentials';
    protected $description = 'Generate a bearer token and HMAC secret for a relay';

    public function handle(): int
    {
        $this->newLine();
        $this->line('BMS_RELAY_TOKEN='.bin2hex(random_bytes(32)));
        $this->line('BMS_RELAY_HMAC_SECRET='.bin2hex(random_bytes(32)));
        $this->newLine();
        $this->warn('Store both values in server/.env and enter the same pair in the relay app.');

        return self::SUCCESS;
    }
}
