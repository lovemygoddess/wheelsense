# WheelSense

<p align="center">
  <b>An open-source, self-hosted telemetry dashboard for electric two-wheelers</b><br />
  Turn vehicle, BMS, relay, and ride data into a dashboard that belongs to the owner.
</p>
<p align="center">
  <a href="README.md">简体中文</a> · <a href="README_EN.md">English</a>
</p>

<p align="center">
  <b>Your ride. Your data. Your dashboard.</b>
</p>

[![CI](https://github.com/lovemygoddess/wheelsense/actions/workflows/ci.yml/badge.svg)](https://github.com/lovemygoddess/wheelsense/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](LICENSE)
[![Android](https://img.shields.io/badge/Android-arm64--v8a-3DDC84?logo=android&logoColor=white)](#quick-start)
[![Self-hosted](https://img.shields.io/badge/deployment-self--hosted-4f46e5)](#server)

WheelSense is an open-source, self-hosted telemetry system for electric bicycles and other electric two-wheelers. It connects BMS, tire-pressure and environment sensors, an Android relay, a server, and the everyday app into one explainable data path that the owner can operate.

## What is WheelSense?

The project has four main parts:

| Component | Purpose |
| --- | --- |
| **WheelSense Dashboard** | A React Native / Expo Android app for vehicle overview, live dashboard, battery, rides, monitoring, and settings. |
| **WheelSense Relay** | A Kotlin Android BLE relay that collects BMS, TPMS, and environment data, buffers it locally, and syncs it to a self-hosted server. |
| **WheelSense Server** | A Laravel backend for telemetry snapshots, history, source selection, alerts, and configuration. |
| **Android Widget** | A native home-screen widget for SOC, range, tire pressure, and freshness at a glance. |

WheelSense does not operate a centralized vehicle-telemetry cloud. Each deployer runs their own server and chooses the data boundary.

## ✨ Project Preview

<p align="center">
  <img src="docs/public-assets/wheelsense-overview-widget.png" width="48%" alt="WheelSense Overview and Widget" />
  <img src="docs/public-assets/wheelsense-rides-battery.png" width="48%" alt="WheelSense Rides and Battery" />
</p>

<p align="center">
  <img src="docs/public-assets/wheelsense-dashboard-monitor-relay.png" width="48%" alt="WheelSense Dashboard Monitor and Relay" />
  <img src="docs/public-assets/wheelsense-theme-settings.png" width="48%" alt="WheelSense Theme and Settings" />
</p>

> Showcase graphics use Demo / synthetic data. Identity, location, and monitoring imagery shown in public materials have been anonymized or replaced with demo content and do not represent a real vehicle or real deployment environment.
>
> Actual features and UI may evolve; refer to the current source code and release version.

## ✨ Main Features

### Vehicle Overview

- SOC, remaining range, odometer, and update time;
- front and rear TPMS pressure / temperature;
- lock state, vehicle online state, and relay connection state;
- relay-phone battery, phone temperature, power state, and ambient temperature / humidity;
- map location and freshness indicators.

### Live Dashboard

- GPS speed, live power, acceleration, and voltage;
- remaining range, satellite / location state, and BMS state;
- a ride-first HUD where speed remains the primary visual value.

### Battery / BMS

- SOC, voltage, current, power, and battery health;
- cycle count, highest / lowest cell voltage, and cell delta;
- cell voltage, temperature, charging history, and voltage trends;
- interactive trend points, drag, crosshair, and tooltips.

### Trips

- today’s ride, history, and date timeline;
- distance, duration, average speed, energy use, and ride maps;
- monthly summaries and ride details.

### Relay

- BLE BMS acquisition and protocol parsing;
- TPMS, environment sensors, and relay state;
- local buffering, batched upload, retries, and offline backfill.

### Monitor

- alert screenshots and alert history;
- immediate capture and opening the camera app;
- camera content is an optional integration, not a claim of PTZ, full live video, or cloud playback.

### Android Widget

- SOC, range, front / rear tire pressure and temperature, and update time;
- Theme Pack support;
- synthetic Demo Mode data with a restrained DEMO marker.

## 🧪 Demo Mode

Demo Mode lets people explore the main UI without a real vehicle or server. Overview, Dashboard, Battery, Trip, Relay, Monitor, and Widget switch to centralized synthetic / deterministic fixtures. Demo data is isolated from production data and does not request or write real vehicle history.

It is useful for:

- screenshots and recordings;
- UI debugging;
- Theme Pack development and demos;
- demonstrating flows without hardware.

Real device operations are blocked or simulated while Demo Mode is active. Turning it off restores the self-hosted data source.

## 🎨 Theme Pack

Theme Packs are independent of data logic. They own color tokens, Light / Dark surfaces, page decoration, Dashboard / Widget visuals, and optional dialogue or artwork resources.

The current packs are:

- **Default-Tech**, a cool violet technology theme;
- **Anime Theme 01**, using an off-white, cherry-pink, and soft-violet direction.

The Chii artwork in Anime Theme 01 is separately identified third-party fan artwork and is not covered by the WheelSense MIT License. Read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [Anime Theme 01 NOTICE](apps/dashboard/assets/themes/anime-01/NOTICE.md) before using it.

## 🏗️ Architecture

~~~mermaid
flowchart LR
  BMS["BMS / BLE"] --> RELAY["WheelSense Relay"]
  SENSOR["TPMS / environment sensors"] --> RELAY
  RELAY --> SERVER["WheelSense Server"]
  SERVER --> DASH["WheelSense Dashboard"]
  SERVER --> WIDGET["Android Widget"]
  BRIDGE["Optional, independent, unofficial NineCLI compatibility bridge"] -.-> SERVER
~~~

NineCLI is only an optional third-party compatibility bridge. It is not a WheelSense API and is not an official Ninebot / Segway service.

## 📐 Data Trustworthiness

WheelSense does not treat “a value exists” as proof that the value is trustworthy. It tracks:

- source, capture time, and freshness;
- live, stale, offline, degraded, and unavailable states;
- BMS priority and a consistent contract across data sources;
- measured V × I × Δt energy intervals instead of blindly trusting vendor estimates;
- gaps, coverage, and anomalous samples before long-term learning;
- one primary telemetry result shared by the home screen, battery view, widget, and API.

See [docs/configuration.md](docs/configuration.md) for deployment and configuration details.

## 📁 Repository Layout

~~~text
apps/dashboard/   React Native / Expo Android Dashboard and Widget
apps/relay/       Kotlin Android BLE Relay
server/           Laravel API, data models, and background jobs
docs/             Deployment and configuration documentation
tools/            Demo screenshot renderer and maintenance tools
~~~

## 🚀 Quick Start

### Dashboard

The Dashboard requires Node.js 20+, JDK 17, and an Android SDK:

~~~bash
cd apps/dashboard
npm ci --legacy-peer-deps
npx expo start
~~~

For a native Android development build:

~~~bash
npx expo run:android
~~~

Set the server URL in the app settings, or use EXPO_PUBLIC_SERVER_URL from [apps/dashboard/.env.example](apps/dashboard/.env.example) for a development build. The public source contains no maintainer server, account, or device identifier.

### Relay

The Relay uses Kotlin, JDK 17, and Android SDK 35:

~~~bash
cd apps/relay
./gradlew assembleDebug --no-daemon
~~~

After installation, enter your own server URL, generated Token / HMAC, and authorized device identifiers in the Relay advanced settings. Never commit real credentials.

### Server

Docker Compose is the simplest deployment path:

~~~bash
cp server/.env.example server/.env
mkdir -p data/database data/storage
docker compose build
docker compose run --rm server php artisan key:generate --show
docker compose run --rm server php artisan evtelemetry:relay-credentials
docker compose up -d
docker compose exec server php artisan evtelemetry:set-dashboard-password
~~~

Put the generated APP_KEY, BMS_RELAY_TOKEN, and BMS_RELAY_HMAC_SECRET into your own server/.env. The default endpoint is http://<host-ip>:8000; use an HTTPS reverse proxy for public access instead of exposing the PHP development server directly.

For a manual Laravel development environment, see the setup script in server/composer.json and read [docs/configuration.md](docs/configuration.md) first.

## 🔐 Data and Privacy

WheelSense is self-hosted. The maintainers do not operate a centralized vehicle-data platform. GPS, rides, BMS, camera, account, and sensor data should remain on the deployer’s own server.

The public repository does not contain:

- passwords, tokens, API secrets, HMAC secrets, or signing keys;
- vehicle SN / VIN, real MAC addresses, GPS, or private server credentials;
- camera verification codes, databases, photos, routes, or real-device caches.

Read [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) before deployment. Connect to, read, or control only vehicles, accounts, BMS devices, sensors, and cameras that you own or are explicitly authorized to access.

## Technology Stack

| Component | Technology |
| --- | --- |
| Dashboard | React Native / Expo |
| Android Native | Kotlin |
| Widget | Android AppWidget / Canvas |
| Relay | Android / BLE |
| Server | Laravel |
| Demo | Synthetic deterministic fixtures |

## ⚠️ Third-Party Compatibility

WheelSense is an independent, unofficial third-party open-source project. It has no official affiliation, authorization, partnership, sponsorship, or endorsement from Ninebot, Segway, 九号, or their affiliates. Those names and trademarks are used only to describe compatibility or data sources and remain with their respective owners.

If mentioned, NineCLI is an optional, independent, unofficial compatibility bridge. It does not represent an official Ninebot API, and it is not included in this repository.

## 📜 License

WheelSense’s own source code is released under the [MIT License](LICENSE). Third-party dependencies, trademarks, images, and fan artwork retain their own rights and terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The repository’s MIT license does not make third-party characters or works MIT-licensed.

---

<p align="center">
  <b>WheelSense</b><br />
  Your ride. Your data. Your dashboard.
</p>
