<?php

namespace App\ValueObjects\Api;

final class ApiResponse
{
    private readonly bool $ok;

    /** @var array<string, mixed> */
    private readonly array $data;

    /** @var array<int, array<string, mixed>> */
    private readonly array $errors;

    /** @var array<string, mixed> */
    private readonly array $meta;

    /**
     * @param  array<string, mixed>  $data
     * @param  array<int, array<string, mixed>|ErrorObject>  $errors
     * @param  array<string, mixed>  $meta
     */
    public function __construct(
        ?string $rootKey = null,
        array $data = [],
        array $errors = [],
        array $meta = [],
    ) {
        $this->ok = $errors === [];
        $this->data = $rootKey !== null ? [$rootKey => $data] : $data;
        $this->errors = array_map(fn (mixed $e): array => $e instanceof ErrorObject ? $e->toArray() : $e, $errors);
        $this->meta = $meta;
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $payload = ['ok' => $this->ok];

        if ($this->ok) {
            foreach ($this->data as $key => $value) {
                $payload[$key] = $value;
            }
        } else {
            $payload['errors'] = $this->errors;
        }

        if ($this->meta !== []) {
            $payload['meta'] = $this->meta;
        }

        return $payload;
    }
}
