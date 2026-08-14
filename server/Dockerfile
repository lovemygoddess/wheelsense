FROM php:8.4-cli

RUN apt-get update \
    && apt-get install -y --no-install-recommends libcurl4-openssl-dev libonig-dev libsqlite3-dev unzip \
    && docker-php-ext-install curl mbstring pdo_sqlite sqlite3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --no-progress --prefer-dist --no-scripts
COPY . .
RUN composer dump-autoload --no-dev --optimize \
    && chmod +x artisan

EXPOSE 8000
CMD ["sh", "-c", "mkdir -p /data storage/app storage/framework/cache storage/framework/sessions storage/framework/views storage/logs && touch /data/database.sqlite && php artisan migrate --force && php artisan serve --host=0.0.0.0 --port=8000"]
