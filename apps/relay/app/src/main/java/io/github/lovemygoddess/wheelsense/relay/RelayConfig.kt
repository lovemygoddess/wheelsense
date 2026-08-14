package io.github.lovemygoddess.wheelsense.relay

import android.content.Context
import android.content.SharedPreferences

/**
 * Runtime configuration for the relay. All values are user-editable in the
 * settings UI. The open-source build deliberately ships without credentials:
 * each installation must use the token/HMAC pair generated on its own server.
 *
 * Defaults:
 *  - serverUrl : public HTTPS entry (Caddy terminates TLS, works off-LAN too)
 *  - token     : BMS_RELAY_TOKEN from the Laravel .env
 *  - deviceSn  : must match the Ninebot device `sn` shown in the dashboard
 *                for cross-verification; left as a placeholder otherwise.
 */
data class RelayConfig(
    val serverUrl: String,
    val token: String,
    val hmacSecret: String,
    val deviceSn: String,
    val sensorMac: String = DEFAULT_SENSOR_MAC,
    /** Device-name prefixes captured for TPMS decoding (empty = capture off). */
    val tpmsCapturePrefixes: Set<String> = DEFAULT_TPMS_PREFIXES,
    /**
     * Debug BLE survey: when true, [MiThermoScanner] captures a throttled
     * sample of EVERY advertiser it hears (not just the TPMS prefixes) into the
     * tpms_capture outbox, so we can discover the sensor's real BLE identity
     * from ground truth instead of guessing its advertisement name. Turn off
     * once the sensor is identified. Bounded by SURVEY_CAP so it can't grow
     * unbounded.
     */
    val tpmsSurveyMode: Boolean = DEFAULT_TPMS_SURVEY,
) {

    /**
     * Server API root derived from the single-sample endpoint. The command and
     * photo endpoints live under `/api/relay/...`, so we strip the known suffix
     * once rather than configuring a second URL.
     */
    val apiBase: String
        get() = if (serverUrl.endsWith("/api/bms-live-snapshot")) {
            serverUrl.removeSuffix("/api/bms-live-snapshot")
        } else {
            serverUrl
        }

    companion object {
        const val DEFAULT_SERVER_URL = "http://192.0.2.10:8000/api/bms-live-snapshot"
        const val DEFAULT_TOKEN = ""
        const val DEFAULT_HMAC_SECRET = ""
        const val DEFAULT_DEVICE_SN = ""

        /**
         * Optional MAC of a Xiaomi LYWSD03MMC (pvvx firmware) sensor.
         * Format: colon-separated, uppercase — matches the MAC embedded in the
         * 0x181A broadcast payload byte-for-byte.
         */
        const val DEFAULT_SENSOR_MAC = ""

        /**
         * BLE device-name prefixes the relay passively captures for TPMS
         * decoding. Compatible Z07 tire-pressure/temp sensors may advertise the
         * name "JH.TPMS" over the air (the "Z07……" strings are cloud-bound
         * serials), so we match both; "TPMS" is a generic safety net. Matching
         * also fires on a known TPMS manufacturer company ID (see
         * [MiThermoScanner.TPMS_MANUFACTURER_IDS]) so nameless data frames are
         * caught too. Set empty to disable capture entirely.
         */
        val DEFAULT_TPMS_PREFIXES: Set<String> = setOf("Z07", "JH", "TPMS")

        /**
         * Debug BLE survey on by default: we still don't know the Z07 sensor's
         * real advertisement name, so capture a sample of every advertiser and
         * identify it from the data. Flip to false once decoding is live.
         */
        const val DEFAULT_TPMS_SURVEY = false

        fun default(): RelayConfig = RelayConfig(
            serverUrl = DEFAULT_SERVER_URL,
            token = DEFAULT_TOKEN,
            hmacSecret = DEFAULT_HMAC_SECRET,
            deviceSn = DEFAULT_DEVICE_SN,
            tpmsCapturePrefixes = DEFAULT_TPMS_PREFIXES,
            tpmsSurveyMode = DEFAULT_TPMS_SURVEY,
        )
    }
}

object Prefs {
    private const val NAME = "bms_relay_prefs"
    private const val K_URL = "server_url"
    private const val K_TOKEN = "token"
    private const val K_HMAC = "hmac_secret"
    private const val K_SN = "device_sn"
    private const val K_SENSOR_MAC = "sensor_mac"
    private const val K_TPMS_SURVEY = "tpms_survey_mode"

    fun load(ctx: Context): RelayConfig {
        val sp = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE)
        val d = RelayConfig.default()
        return RelayConfig(
            serverUrl = sp.getString(K_URL, null) ?: d.serverUrl,
            token = sp.getString(K_TOKEN, null) ?: d.token,
            hmacSecret = sp.getString(K_HMAC, null) ?: d.hmacSecret,
            deviceSn = sp.getString(K_SN, null) ?: d.deviceSn,
            sensorMac = sp.getString(K_SENSOR_MAC, null) ?: d.sensorMac,
            tpmsSurveyMode = sp.getBoolean(K_TPMS_SURVEY, d.tpmsSurveyMode),
        )
    }

    fun save(ctx: Context, cfg: RelayConfig) {
        ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE).edit().apply {
            putString(K_URL, cfg.serverUrl)
            putString(K_TOKEN, cfg.token)
            putString(K_HMAC, cfg.hmacSecret)
            putString(K_SN, cfg.deviceSn)
            putString(K_SENSOR_MAC, cfg.sensorMac)
            putBoolean(K_TPMS_SURVEY, cfg.tpmsSurveyMode)
            apply()
        }
    }
}
