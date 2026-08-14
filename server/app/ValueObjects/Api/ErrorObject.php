<?php

namespace App\ValueObjects\Api;

final readonly class ErrorObject
{
    public function __construct(
        public string $type,
        public string $code,
        public string $message,
    ) {}

    public function toArray(): array
    {
        return [
            'type' => $this->type,
            'code' => $this->code,
            'message' => $this->message,
        ];
    }
}
