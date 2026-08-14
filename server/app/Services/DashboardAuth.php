<?php

namespace App\Services;

use Illuminate\Support\Facades\Hash;

class DashboardAuth
{
    private const STORAGE_PATH = 'dashboard-auth.json';

    public static function path(): string
    {
        return storage_path('app/' . self::STORAGE_PATH);
    }

    public static function isConfigured(): bool
    {
        return file_exists(self::path());
    }

    public static function verify(string $password): bool
    {
        if (! self::isConfigured()) {
            return false;
        }
        $hash = json_decode(file_get_contents(self::path()), true)['password_hash'] ?? '';
        return $hash !== '' && Hash::check($password, $hash);
    }

    public static function set(string $password): void
    {
        $dir = dirname(self::path());
        if (! is_dir($dir)) {
            mkdir($dir, 0755, true);
        }
        file_put_contents(
            self::path(),
            json_encode(['password_hash' => Hash::make($password)], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
        );
    }
}
