package io.github.lovemygoddess.wheelsense.relay

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * The relay's SOLE BLE scanner. It listens for the Xiaomi LYWSD03MMC running
 * the pvvx "Custom" firmware AND forwards every device it sees to
 * [BleManager.considerDevice] so the ANT BMS board can be connected.
 *
 * Why one scanner only:
 *   [BleManager] used to run its own scan, but two concurrent startScan() calls
 *   on the single BluetoothLeScanner the OS exposes per adapter clobber each
 *   other's callback registration on Samsung firmware — neither onScanResult
 *   ever fired (the hygrometer feed dying at 08:49 was the visible symptom).
 *   Routing both consumers through this one scanner removes the contention.
 *
 * Normal operation uses one non-empty OR filter list for TPMS, the configured
 * 0x181A environment sensor, and a persisted BMS address when available. A
 * bounded unfiltered discovery pass is used only while the BMS identity is
 * unknown (or when the user explicitly asks for discovery). This keeps the
 * screen-off path eligible for framework filtered scanning without creating a
 * second scanner that could clobber the ANT GATT path on Samsung firmware.
 *
 * No connection is ever made to the sensor — passive listening is what lets the
 * CR2032 last ~a year.
 */
@SuppressLint("MissingPermission")
class MiThermoScanner(
    private val ctx: Context,
    private val store: RelayStore,
    private val deviceSn: String,
    private val sensorMac: String?,
    /** Every device this sole scanner sees is forwarded here so the BMS board
     *  path ([BleManager.considerDevice]) can connect. The relay no longer runs
     *  its own BLE scan. */
    private val onDeviceSeen: ((ScanResult) -> Unit)? = null,
    /** Device-name prefixes captured for TPMS decoding. Empty = capture off. */
    private val tpmsCapturePrefixes: Set<String> = TPMS_CAPTURE_PREFIXES,
    /** Debug: capture a throttled sample of EVERY advertiser (see RelayConfig). */
    private val tpmsSurveyMode: Boolean = false,
    /** Notifies the owning service that a TPMS row entered the durable outbox. */
    private val onTpmsCaptureEnqueued: (() -> Unit)? = null,
    /** Kicks the existing single-flight uploader after an ENV row is queued. */
    private val onEnvEnqueued: (() -> Unit)? = null,
    /** Reads the persisted ANT board address without hard-coding a device id. */
    private val knownBmsMacProvider: (() -> String?)? = null,
) {

    data class Reading(
        val sensorMac: String,
        val tempC: Float,
        val humidityPct: Float,
        val sensorBatteryMv: Int,
        val rssi: Int,
        val capturedAtIso: String,
    )

    /** Latest reading, surfaced to the UI / debug. */
    @Volatile var latest: Reading? = null
        private set

    var onReading: ((Reading) -> Unit)? = null

    companion object {
        private val ENV_UUID = UUID.fromString("0000181a-0000-1000-8000-00805f9b34fb")

        /**
         * Device-name prefixes we passively capture for TPMS decoding. The
         * Compatible tire-pressure/temp sensors may advertise a vendor-specific
         * name; any BLE device whose advertised name starts with a configured
         * generic prefix gets its full raw
         * advertisement PDU recorded for later decoding. Set empty to disable
         * capture entirely.
         */
        val TPMS_CAPTURE_PREFIXES: Set<String> = setOf("JH", "TPMS")

        /**
         * Throttle: at most one env record every this many ms, and only when the
         * reading moved past the delta thresholds. The sensor broadcasts a few
         * times a second; the dashboard only needs a fresh value a few times a
         * minute, so we keep the outbox tiny.
         */
        private const val MIN_INTERVAL_MS = 30_000L
        private const val DELTA_TEMP_C = 0.1f
        private const val DELTA_HUM_PCT = 0.5f
        private const val DELTA_BATT_MV = 10

        // ---- Diagnostics -----------------------------------------------------
        // Surfaced in the relay's own UI. Without these a "no data" report is
        // unfalsifiable: not scanning, scanning but filtered out, wrong MAC and
        // wrong payload length all look identical from the dashboard.

        /** Human-readable scan state, e.g. "扫描中(0x181A过滤)" / "蓝牙未开启". */
        @Volatile var diagScanState: String = "未启动"

        /** 0x181A service-data frames seen, regardless of MAC. */
        @Volatile var diagRawHits: Long = 0

        /** Layered ENV diagnostics: delivery by advertised UUID/data, parser,
         * embedded-MAC validation and durable enqueue. */
        @Volatile var diagEnvRawScanSeen: Long = 0
        @Volatile var diagEnvFilterSeen: Long = 0
        @Volatile var diagEnvServiceUuidHits: Long = 0
        @Volatile var diagEnvServiceDataHits: Long = 0
        @Volatile var diagEnvLastRssi: Int = 0
        @Volatile var diagEnvParseOk: Long = 0
        @Volatile var diagEnvParseFail: Long = 0
        @Volatile var diagEnvMacMatches: Long = 0
        @Volatile var diagEnvMacMismatches: Long = 0
        @Volatile var diagEnvLastParseFailure: String = ""
        @Volatile var diagEnvLastEnqueuedMs: Long = 0

        /** Frames dropped because the embedded MAC wasn't the configured one. */
        @Volatile var diagMacMismatch: Long = 0

        /** Most recent non-matching MAC — lets the user spot a mistyped address. */
        @Volatile var diagLastOtherMac: String? = null

        /** Payload length of the last frame too short to be a pvvx Custom frame. */
        @Volatile var diagLastBadLen: Int = -1

        /** Rows actually pushed into the outbox. */
        @Volatile var diagEnqueued: Long = 0

        /** TPMS frames seen (device name matched a capture prefix). */
        @Volatile var diagTpmsSeen: Long = 0

        /** TPMS raw captures actually pushed into the outbox. */
        @Volatile var diagTpmsEnqueued: Long = 0

        /** Monotonic process diagnostics for the formal TPMS path. */
        @Volatile var diagTpmsDedicatedEnqueued: Long = 0
        @Volatile var diagTpmsLastSeenMs: Long = 0
        @Volatile var diagTpmsLastEnqueuedMs: Long = 0

        @Volatile var diagScanProfile: String = ScannerPolicy.BACKGROUND_FILTERED
        @Volatile var diagFiltered: Boolean = false
        @Volatile var diagFilterCount: Int = 0
        @Volatile var diagScanMode: String = "UNKNOWN"
        @Volatile var diagScanGeneration: Long = 0
        @Volatile var diagLastStartAttemptMs: Long = 0
        @Volatile var diagLastStartSuccessMs: Long = 0
        @Volatile var diagLastScanResultMs: Long = 0
        @Volatile var diagLastFailureCode: Int = 0
        @Volatile var diagLastFailureName: String = ""
        @Volatile var diagPendingRestartReason: String = ""
        @Volatile var diagNextRestartAtMs: Long = 0
        @Volatile var diagThermoLastSeenMs: Long = 0
        @Volatile var diagThermoLastRssi: Int = 0
        @Volatile var diagTpmsPeerSummary: String = ""

        /** Times startScan() failed (SCAN_FAILED_*). A climbing count with no
         *  board/env data means the scan session keeps dying on (re)start — the
         *  classic Samsung "scan running but 0 results forever" symptom. */
        @Volatile var diagScanFailures: Long = 0

        /** Failures since the last delivered scan result. Unlike the running
         *  total this drops back to 0 the moment the scanner works again, so a
         *  non-zero value in a heartbeat means "broken right now". */
        @Volatile var diagConsecFailures: Int = 0

        /** Wall-clock ms of the last accepted reading, 0 if never. */
        @Volatile var diagLastReadingMs: Long = 0

        /** One-line summary for the settings screen. */
        fun diagLine(): String {
            val sb = StringBuilder("扫描状态=").append(diagScanState)
                .append(" profile=").append(diagScanProfile)
                .append(" filtered=").append(diagFiltered)
                .append(" filters=").append(diagFilterCount)
                .append(" mode=").append(diagScanMode)
                .append(" gen=").append(diagScanGeneration)
            if (diagLastStartAttemptMs > 0) {
                sb.append(" start_age=").append(ageSeconds(diagLastStartAttemptMs)).append('s')
            }
            if (diagLastStartSuccessMs > 0) {
                sb.append(" success_age=").append(ageSeconds(diagLastStartSuccessMs)).append('s')
            }
            if (diagLastScanResultMs > 0) {
                sb.append(" result_age=").append(ageSeconds(diagLastScanResultMs)).append('s')
            }
            if (diagLastFailureCode != 0) {
                sb.append(" failure=").append(diagLastFailureCode)
                    .append('/').append(diagLastFailureName)
            }
            if (diagPendingRestartReason.isNotBlank()) {
                sb.append(" pending=").append(diagPendingRestartReason)
                if (diagNextRestartAtMs > 0) {
                    sb.append(" in=").append(((diagNextRestartAtMs - System.currentTimeMillis()) / 1000).coerceAtLeast(0)).append('s')
                }
            }
            sb.append(" | 温湿度: ").append(diagScanState)
            sb.append(" 命中").append(diagRawHits)
            if (diagMacMismatch > 0) {
                sb.append(" MAC不符").append(diagMacMismatch)
                diagLastOtherMac?.let { sb.append('(').append(it).append(')') }
            }
            if (diagLastBadLen >= 0) sb.append(" 短包").append(diagLastBadLen).append('B')
            sb.append(" 入队").append(diagEnqueued)
            if (diagTpmsSeen > 0) {
                sb.append(" 胎压命中").append(diagTpmsSeen)
                    .append(" 抓包").append(diagTpmsEnqueued)
                    .append(" 胎压专用").append(diagTpmsDedicatedEnqueued)
                if (diagTpmsLastSeenMs > 0) {
                    sb.append(" 见").append((System.currentTimeMillis() - diagTpmsLastSeenMs).coerceAtLeast(0) / 1000).append('s')
                }
                if (diagTpmsLastEnqueuedMs > 0) {
                    sb.append(" 入").append((System.currentTimeMillis() - diagTpmsLastEnqueuedMs).coerceAtLeast(0) / 1000).append('s')
                }
            }
            if (diagThermoLastSeenMs > 0) {
                sb.append(" 温湿度最近=").append(ageSeconds(diagThermoLastSeenMs)).append('s')
                    .append("@RSSI").append(diagThermoLastRssi)
            }
            sb.append(" ENV分层=")
                .append("raw:").append(diagEnvRawScanSeen)
                .append(" filter:").append(diagEnvFilterSeen)
                .append(" uuid:").append(diagEnvServiceUuidHits)
                .append(" data:").append(diagEnvServiceDataHits)
                .append(" rssi:").append(diagEnvLastRssi)
                .append(" ok:").append(diagEnvParseOk)
                .append(" fail:").append(diagEnvParseFail)
                .append(" mac:").append(diagEnvMacMatches).append('/').append(diagEnvMacMismatches)
                .append(" 入队:").append(diagEnqueued)
                .append(" 最近入队:").append(if (diagEnvLastEnqueuedMs > 0) ageSeconds(diagEnvLastEnqueuedMs) else "-").append('s')
            if (diagEnvLastParseFailure.isNotBlank()) {
                sb.append(" 解析失败=").append(diagEnvLastParseFailure)
            }
            if (diagTpmsPeerSummary.isNotBlank()) sb.append(" peers=").append(diagTpmsPeerSummary)
            if (diagScanFailures > 0) sb.append(" 扫描失败").append(diagScanFailures)
            if (diagConsecFailures > 0) sb.append(" 连续失败").append(diagConsecFailures)
            if (diagLastReadingMs > 0) {
                val age = (System.currentTimeMillis() - diagLastReadingMs) / 1000
                sb.append(" 距上次").append(age).append('s')
            }
            return sb.toString()
        }

        private fun ageSeconds(atMs: Long): Long =
            ((System.currentTimeMillis() - atMs).coerceAtLeast(0L) / 1000L)
    }

    @Volatile private var running = false
    private enum class ScanState { STOPPED, STARTING, RUNNING, BACKOFF, RESTART_PENDING }
    private enum class ScanProfile { BACKGROUND_FILTERED, DISCOVERY_UNFILTERED }

    @Volatile private var scanState = ScanState.STOPPED
    @Volatile private var isScanning = false
    @Volatile private var scanGeneration = 0L
    private val mainHandler = Handler(Looper.getMainLooper())
    private var scanner: android.bluetooth.le.BluetoothLeScanner? = null
    private var pendingRestart: Runnable? = null
    private var pendingRestartReason: String = ""
    private var discoveryTimeout: Runnable? = null
    private var scanProfile = ScanProfile.BACKGROUND_FILTERED

    /** Samsung Oreo parks a background scan as opportunistic once the device
     *  idles in the tail box, so onScanResult stops firing while the scan still
     *  "runs". Re-issuing the scan every few minutes wakes it back up. The relay
     *  is mains-powered, so the churn is free. */
    private val HIGH_PERF_KEEPALIVE_MS = 90_000L
    private val LOW_POWER_KEEPALIVE_MS = 3 * 60_000L
    @Volatile private var highPerformance = true
    @Volatile private var economyMode = false
    /** Phase is an optimization hint only; it never gates TPMS listening. */
    @Volatile private var tpmsWindowActive = false

    private val tpmsLastSeenElapsed = ConcurrentHashMap<String, Long>()
    private val tpmsPeriodMs = ConcurrentHashMap<String, Long>()
    private val tpmsNextDueElapsed = ConcurrentHashMap<String, Long>()
    private val TPMS_DEFAULT_PERIOD_MS = 570_000L
    private val TPMS_MIN_PERIOD_MS = 7 * 60_000L
    private val TPMS_MAX_PERIOD_MS = 12 * 60_000L
    private val TPMS_WINDOW_BEFORE_MS = 45_000L
    private val TPMS_WINDOW_AFTER_MS = 60_000L
    private val TPMS_PHASE_TICK_MS = 10_000L
    private val DISCOVERY_MAX_MS = 60_000L

    private val tpmsPhaseRunnable = object : Runnable {
        override fun run() {
            if (!running) return
            val now = SystemClock.elapsedRealtime()
            var shouldBoost = false
            for ((mac, due0) in tpmsNextDueElapsed.entries) {
                var due = due0
                val period = tpmsPeriodMs[mac] ?: TPMS_DEFAULT_PERIOD_MS
                // A missed frame must not leave the scanner permanently boosted.
                while (now > due + TPMS_WINDOW_AFTER_MS) due += period
                if (due != due0) tpmsNextDueElapsed[mac] = due
                if (now >= due - TPMS_WINDOW_BEFORE_MS && now <= due + TPMS_WINDOW_AFTER_MS) {
                    shouldBoost = true
                }
            }
            if (tpmsWindowActive != shouldBoost) {
                tpmsWindowActive = shouldBoost
            }
            mainHandler.postDelayed(this, TPMS_PHASE_TICK_MS)
        }
    }
    private val discoveryTimeoutRunnable = Runnable {
        if (!running || scanProfile != ScanProfile.DISCOVERY_UNFILTERED) return@Runnable
        scanProfile = ScanProfile.BACKGROUND_FILTERED
        requestRestart("discovery_timeout", SCAN_RESTART_DELAY_MS)
    }

    /** Delay between stopScan() and the next startScan(). See [requestRestart] —
     *  without it Samsung Oreo coalesces the two into one call and the scan
     *  stays parked at 0 results. */
    private val SCAN_RESTART_DELAY_MS = 1_000L

    /** First retry delay after a scan failure; doubles up to [FAIL_BACKOFF_MAX_MS]. */
    private val FAIL_BACKOFF_MIN_MS = 2_000L
    private val FAIL_BACKOFF_MAX_MS = 60_000L
    private var failBackoffMs = FAIL_BACKOFF_MIN_MS

    // Last uploaded values, for the change-based throttle.
    private var lastUploadMs = 0L
    private var lastTempC = Float.NaN
    private var lastHumPct = Float.NaN
    private var lastBattMv = -1

    /** Identical TPMS payloads are de-duplicated; changed payloads get a 1 s floor. */
    private val TPMS_CAPTURE_SAME_PAYLOAD_MS = 10_000L
    private val TPMS_CAPTURE_CHANGED_PAYLOAD_MS = 1_000L

    private data class TpmsThrottleState(
        var lastCaptureMs: Long = 0L,
        var lastPayload: String? = null,
    )

    private data class TpmsPeerStats(
        var lastSeenMs: Long = 0L,
        var lastEnqueuedMs: Long = 0L,
        var seenCount: Long = 0L,
        var enqueuedCount: Long = 0L,
        var lastRssi: Int = 0,
        var lastPayloadChangeMs: Long = 0L,
        var lastPayload: String? = null,
        var lastDropReason: String = "",
    )

    private val tpmsThrottle = ConcurrentHashMap<String, TpmsThrottleState>()
    private val tpmsPeerStats = ConcurrentHashMap<String, TpmsPeerStats>()

    /** Debug survey: hard cap on total captured advertisers so it can't grow
     *  unbounded in the offline outbox / server table. High enough to survive a
     *  multi-minute ride while still bounding the debug table. TPMS frames do
     *  NOT count against this cap (see [isTpmsLike] / [TPMS_DEDICATED_CAP]). */
    private val TPMS_SURVEY_CAP = 8000
    private val tpmsSurveyCount = java.util.concurrent.atomic.AtomicInteger(0)

    /** Known TPMS manufacturer company IDs, aligned with the backend decoder
     *  (TpmsController::TPMS_COMPANY_IDS). A frame from one of these is always
     *  captured (even with no device name) and never counts against the survey
     *  cap, so the tire sensor's data frames can't be squeezed out by the noisy
     *  BLE neighbourhood while the vehicle is parked for days. */
    private val TPMS_MANUFACTURER_IDS: Set<Int> = setOf(0x1E00, 0x1E01, 0x1E02)

    /** Dedicated, much higher cap for TPMS frames. They only arrive while the
     *  wheels move, so even a long ride produces a bounded number; this just
     *  prevents a pathological multi-day capture from growing without limit. */
    private val TPMS_DEDICATED_CAP = 20000
    private val tpmsDedicatedCount = java.util.concurrent.atomic.AtomicInteger(0)

    /** True if a scan result looks like a TPMS advertisement: by advertised name
     *  prefix, by a name token anywhere in the raw PDU, or by a known TPMS
     *  manufacturer company ID (covers nameless data frames). */
    private fun isTpmsLike(result: ScanResult): Boolean {
        val record = result.scanRecord ?: return false
        val name = record.deviceName
        if (name != null && tpmsCapturePrefixes.any { name.startsWith(it, ignoreCase = true) }) {
            return true
        }
        val raw = record.bytes
        if (raw != null) {
            val rawAscii = String(raw, Charsets.US_ASCII)
            if (tpmsCapturePrefixes.any { rawAscii.contains(it, ignoreCase = true) }) return true
        }
        val manuData = record.manufacturerSpecificData
        if (manuData != null) {
            for (i in 0 until manuData.size()) {
                if (TPMS_MANUFACTURER_IDS.contains(manuData.keyAt(i))) return true
            }
        }
        return false
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            try {
                // Any delivered result proves the scan session is genuinely
                // alive, so the failure streak and its backoff start over.
                diagLastScanResultMs = System.currentTimeMillis()
                val resultGeneration = scanGeneration
                mainHandler.post { onHealthyScanResult(resultGeneration) }
                val nm = result.scanRecord?.deviceName
                val ad = result.device?.address
                val scanRecord = result.scanRecord
                diagEnvRawScanSeen++
                if (diagFiltered) diagEnvFilterSeen++
                if (scanRecord?.serviceUuids?.contains(ParcelUuid(ENV_UUID)) == true) {
                    diagEnvServiceUuidHits++
                }
                if (scanRecord?.getServiceData(ParcelUuid(ENV_UUID)) != null) {
                    diagEnvServiceDataHits++
                    diagEnvLastRssi = result.rssi
                }
                if (BuildConfig.DEBUG) {
                    Log.d("MiThermo", "seen name=\"$nm\" addr=$ad rssi=${result.rssi}")
                }
                // Forward every device to the BMS board path (which needs an
                // unfiltered scan to see the ANT board), then try to decode this
                // frame as a thermo reading. Non-thermo frames bail out of
                // handleResult on the first byte, so the extra work is cheap.
                onDeviceSeen?.invoke(result)
                handleResult(result)
                captureTpms(result)
            } catch (_: Throwable) {
                // Never let a scan callback kill the binder thread.
            }
        }

        override fun onScanFailed(errorCode: Int) {
            Log.e("MiThermo", "scan failed code=$errorCode")
            // Scan callbacks arrive from the framework binder thread. All
            // lifecycle transitions are serialized on the scanner Handler.
            mainHandler.post { handleScanFailure(errorCode) }
        }
    }

    fun start() {
        runOnMain {
            if (running) return@runOnMain
            running = true
            scanProfile = if (knownBmsMac().isNullOrBlank()) {
                ScanProfile.DISCOVERY_UNFILTERED
            } else {
                ScanProfile.BACKGROUND_FILTERED
            }
            nextGeneration()
            scheduleDiscoveryTimeoutIfNeeded()
            tryStartScanOnMain(scanGeneration)
            mainHandler.removeCallbacks(tpmsPhaseRunnable)
            mainHandler.postDelayed(tpmsPhaseRunnable, TPMS_PHASE_TICK_MS)
        }
    }

    fun stop() {
        runOnMain { stopOnMain() }
    }

    /** Switches scan duty without creating a second scanner. */
    fun setHighPerformance(enabled: Boolean) {
        mainHandler.post {
            if (highPerformance == enabled) return@post
            highPerformance = enabled
            if (running) requestRestart("scan_mode_change", SCAN_RESTART_DELAY_MS)
        }
    }

    /** Controls the parked scan profile without affecting a discovery burst. */
    fun setEconomyMode(enabled: Boolean) {
        mainHandler.post {
            if (economyMode == enabled) return@post
            economyMode = enabled
            if (running && !highPerformance) requestRestart("economy_mode_change", SCAN_RESTART_DELAY_MS)
        }
    }

    /** Bounded discovery. Known BMS identities stay filtered even when disconnected. */
    fun startDiscoveryBurst() {
        mainHandler.post {
            highPerformance = true
            if (knownBmsMac().isNullOrBlank()) {
                scanProfile = ScanProfile.DISCOVERY_UNFILTERED
                scheduleDiscoveryTimeoutIfNeeded()
            } else {
                scanProfile = ScanProfile.BACKGROUND_FILTERED
                cancelDiscoveryTimeout()
            }
            if (running) requestRestart("discovery_requested", SCAN_RESTART_DELAY_MS)
        }
    }

    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    private fun knownBmsMac(): String? = try {
        knownBmsMacProvider?.invoke()?.takeIf { it.isNotBlank() }
    } catch (_: Throwable) {
        null
    }

    private fun nextGeneration(): Long {
        scanGeneration += 1L
        diagScanGeneration = scanGeneration
        return scanGeneration
    }

    private fun cancelPendingRestart() {
        pendingRestart?.let { mainHandler.removeCallbacks(it) }
        pendingRestart = null
        pendingRestartReason = ""
        diagPendingRestartReason = ""
        diagNextRestartAtMs = 0L
    }

    private fun cancelDiscoveryTimeout() {
        discoveryTimeout?.let { mainHandler.removeCallbacks(it) }
        discoveryTimeout = null
    }

    private fun scheduleDiscoveryTimeoutIfNeeded() {
        cancelDiscoveryTimeout()
        if (!running || scanProfile != ScanProfile.DISCOVERY_UNFILTERED) return
        val generation = scanGeneration
        discoveryTimeout = Runnable {
            if (running && scanProfile == ScanProfile.DISCOVERY_UNFILTERED && generation == scanGeneration) {
                scanProfile = ScanProfile.BACKGROUND_FILTERED
                requestRestart("discovery_timeout", SCAN_RESTART_DELAY_MS)
            }
        }
        mainHandler.postDelayed(discoveryTimeout!!, DISCOVERY_MAX_MS)
    }

    private fun stopCurrentScanOnMain() {
        try { scanner?.stopScan(scanCallback) } catch (_: Throwable) { }
        isScanning = false
    }

    private fun stopOnMain() {
        running = false
        nextGeneration()
        cancelPendingRestart()
        cancelDiscoveryTimeout()
        mainHandler.removeCallbacks(tpmsPhaseRunnable)
        mainHandler.removeCallbacks(keepaliveRunnable)
        stopCurrentScanOnMain()
        scanner = null
        scanState = ScanState.STOPPED
        diagScanState = "未启动"
    }

    private fun requestRestart(reason: String, delayMs: Long) {
        if (!running) return
        cancelPendingRestart()
        nextGeneration()
        stopCurrentScanOnMain()
        scanState = ScanState.RESTART_PENDING
        diagScanState = "重启等待"
        val generation = scanGeneration
        pendingRestartReason = reason
        diagPendingRestartReason = reason
        diagNextRestartAtMs = System.currentTimeMillis() + delayMs
        val task = Runnable {
            if (!running || generation != scanGeneration) return@Runnable
            pendingRestart = null
            pendingRestartReason = ""
            diagPendingRestartReason = ""
            diagNextRestartAtMs = 0L
            tryStartScanOnMain(generation)
        }
        pendingRestart = task
        mainHandler.postDelayed(task, delayMs)
    }

    private fun tryStartScanOnMain(expectedGeneration: Long = scanGeneration) {
        if (!running || expectedGeneration != scanGeneration || isScanning) return
        scanState = ScanState.STARTING
        diagLastStartAttemptMs = System.currentTimeMillis()
        val adapter = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter == null || !adapter.isEnabled) {
            diagScanState = "蓝牙未开启"
            scanState = ScanState.BACKOFF
            requestRestart("bluetooth_not_ready", 30_000L)
            return
        }
        val sc = try { adapter.bluetoothLeScanner } catch (_: Throwable) { null }
        if (sc == null) {
            diagScanState = "扫描器不可用"
            scanState = ScanState.BACKOFF
            requestRestart("scanner_unavailable", 30_000L)
            return
        }
        scanner = sc
        val filters = buildScanFilters()
        val mode = when {
            highPerformance || tpmsWindowActive -> ScanSettings.SCAN_MODE_LOW_LATENCY
            economyMode -> ScanSettings.SCAN_MODE_LOW_POWER
            else -> ScanSettings.SCAN_MODE_BALANCED
        }
        diagScanProfile = scanProfile.name
        diagFiltered = filters.isNotEmpty()
        diagFilterCount = filters.size
        diagScanMode = mode.toString()
        try {
            sc.startScan(filters, ScanSettings.Builder().setScanMode(mode).build(), scanCallback)
            isScanning = true
            scanState = ScanState.RUNNING
            diagLastStartSuccessMs = System.currentTimeMillis()
            val label = if (filters.isEmpty()) "DISCOVERY_UNFILTERED" else "BACKGROUND_FILTERED"
            diagScanState = "扫描中($label)"
            failBackoffMs = FAIL_BACKOFF_MIN_MS
            scheduleKeepalive()
        } catch (_: SecurityException) {
            diagScanState = "缺少定位/扫描权限"
            scanState = ScanState.BACKOFF
            requestRestart("start_failure_permission", FAIL_BACKOFF_MAX_MS)
        } catch (e: Throwable) {
            Log.e("MiThermo", "scan start failed", e)
            diagScanState = "扫描启动失败"
            scanState = ScanState.BACKOFF
            requestRestart("start_failure_exception", failBackoffMs)
            failBackoffMs = (failBackoffMs * 2).coerceAtMost(FAIL_BACKOFF_MAX_MS)
        }
    }

    private fun buildScanFilters(): List<ScanFilter> {
        if (scanProfile == ScanProfile.DISCOVERY_UNFILTERED) return emptyList()
        val filters = mutableListOf<ScanFilter>()
        val (data, mask) = ScannerPolicy.tpmsWildcardPayload()
        filters += ScanFilter.Builder()
            .setManufacturerData(ScannerPolicy.TPMS_MANUFACTURER_ID, data, mask)
            .build()
        filters += ScanFilter.Builder().setServiceUuid(ParcelUuid(ENV_UUID)).build()
        // Some Samsung controller firmwares match 0x181A service UUIDs but
        // omit service-data results from a UUID-only offloaded filter. Keep the
        // UUID filter and add a zero-mask service-data filter (payload wildcard)
        // so both advertising layouts are delivered without unfiltered scans.
        try {
            filters += ScanFilter.Builder()
                .setServiceData(ParcelUuid(ENV_UUID), byteArrayOf(0), byteArrayOf(0))
                .build()
        } catch (_: IllegalArgumentException) {
            // A vendor stack that rejects a wildcard service-data mask still
            // keeps the original UUID filter; never take the scanner down.
        }
        knownBmsMac()?.takeIf { it.matches(Regex("(?i)^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")) }?.let {
            filters += ScanFilter.Builder().setDeviceAddress(it.uppercase()).build()
        }
        return filters
    }

    private fun handleScanFailure(errorCode: Int) {
        isScanning = false
        diagScanFailures++
        diagConsecFailures++
        diagLastFailureCode = errorCode
        diagLastFailureName = ScannerPolicy.failureName(errorCode)
        if (errorCode == ScanCallback.SCAN_FAILED_ALREADY_STARTED) {
            // Code 1 means the framework believes a registration already exists.
            // Leave it alone for a bounded watchdog instead of creating a restart storm.
            scanState = ScanState.RUNNING
            diagScanState = "已有注册等待结果"
            val generation = scanGeneration
            mainHandler.postDelayed({
                if (running && generation == scanGeneration && diagLastScanResultMs < diagLastStartAttemptMs) {
                    requestRestart("scan_failure_already_started_watchdog", 1_000L)
                }
            }, 90_000L)
            return
        }
        scanState = ScanState.BACKOFF
        diagScanState = "扫描失败(${diagLastFailureName})"
        val delay = failBackoffMs
        failBackoffMs = (failBackoffMs * 2).coerceAtMost(FAIL_BACKOFF_MAX_MS)
        requestRestart("scan_failure_${diagLastFailureName}", delay)
    }

    private fun onHealthyScanResult(resultGeneration: Long) {
        if (!running || resultGeneration != scanGeneration) return
        diagLastScanResultMs = System.currentTimeMillis()
        diagConsecFailures = 0
        failBackoffMs = FAIL_BACKOFF_MIN_MS
        if (diagPendingRestartReason.startsWith("scan_failure") ||
            diagPendingRestartReason.startsWith("start_failure")) {
            cancelPendingRestart()
            scanState = ScanState.RUNNING
            isScanning = true
            diagScanState = "扫描中(${scanProfile.name})"
        }
    }

    /**
     * Samsung Oreo silently parks a background BLE scan as opportunistic once
     * the device is idle in the tail box, so onScanResult stops firing even
     * though the scan still "runs" (see the 0-results-forever dumpsys symptom).
     * Re-issuing the scan every [SCAN_KEEPALIVE_MS] wakes it back up. The relay
     * is mains-powered, so the extra churn is free.
     *
     * The re-issue goes through [requestRestart] (stop + delayed start) so each
     * wake-up actually creates a fresh scan session instead of re-binding to the
     * parked one.
     *
     * CRITICAL: exactly ONE pending keepalive may ever exist. A previous build
     * posted the lambda inline (so removeCallbacks couldn't find it) AND called
     * scheduleKeepalive() twice per cycle (once via startScanInternal's success
     * path, once at the runnable's end). Every 90 s the timer count doubled;
     * ~15 min in, thousands of concurrent stop/startScan calls tripped Samsung's
     * 5-scans/30 s rate limit and killed the scan for good. A NAMED Runnable +
     * removeCallbacks before every post makes the singleton invariant hold no
     * matter how many times scheduleKeepalive() is called.
     */
    private val keepaliveRunnable = object : Runnable {
        override fun run() {
            if (!running) return
            if (BuildConfig.DEBUG) Log.d("MiThermo", "keepalive: re-issuing scan")
            requestRestart("keepalive", SCAN_RESTART_DELAY_MS)
            scheduleKeepalive()
        }
    }

    private fun scheduleKeepalive() {
        mainHandler.removeCallbacks(keepaliveRunnable)
        val delay = if (highPerformance || tpmsWindowActive) HIGH_PERF_KEEPALIVE_MS else LOW_POWER_KEEPALIVE_MS
        if (running) mainHandler.postDelayed(keepaliveRunnable, delay)
    }

    /**
     * Some BLE stacks offload filtering to the controller and handle
     * service-data matching poorly. If the filtered pass yields nothing at all
     * within the probe window, drop the filter and match in software instead —
     * [handleResult] bails out on the very first byte for non-0x181A frames, so
     * the extra callbacks are cheap.
     */
    private fun handleResult(result: ScanResult) {
        val record = result.scanRecord ?: return
        val data = record.getServiceData(ParcelUuid(ENV_UUID)) ?: return
        diagRawHits++
        diagThermoLastSeenMs = System.currentTimeMillis()
        diagThermoLastRssi = result.rssi
        val reading = parse(data, result.rssi) ?: return
        diagEnvParseOk++
        // Whitelist by the MAC embedded in the payload (authoritative), not the
        // possibly-randomized Android device address.
        if (!reading.sensorMac.equals(sensorMac, ignoreCase = true)) {
            diagMacMismatch++
            diagEnvMacMismatches++
            diagLastOtherMac = reading.sensorMac
            return
        }

        diagEnvMacMatches++
        diagLastBadLen = -1
        diagLastReadingMs = System.currentTimeMillis()
        latest = reading
        onReading?.invoke(reading)
        maybeEnqueue(reading)
    }

    /**
     * Passive TPMS capture. Compatible tire-pressure/temp sensors broadcast
     * over BLE; the relay — locked in the tail box and already the sole BLE
     * scanner — records their full raw advertisement PDU (plus the
     * manufacturer- and service-data maps) so we can reverse-engineer the
     * pressure/temperature encoding off-device, without connecting to or
     * disturbing the sensor.
     *
     * Matching is by advertised device-name prefix, OR — as a fallback for
     * sensors that don't surface a name via [android.bluetooth.le.ScanRecord.getDeviceName]
     * — by a configured generic token appearing anywhere in the raw advertising PDU. The
     * raw-bytes fallback is what actually fires for sensors that carry the name
     * only inside the advertisement body / scan response. Capture is throttled
     * per device (name when present, else MAC) so a chatty sensor can't flood
     * the offline outbox; a few frames a minute is more than enough to decode a
     * layout that barely changes.
     */
    private fun captureTpms(result: ScanResult) {
        val record = result.scanRecord ?: return

        // ---- Debug survey: capture a throttled sample of EVERY advertiser ----
        // Survey mode intentionally samples unknown advertisers for diagnosis;
        // dump a bounded sample of everything the relay hears and identify the
        // tire sensor from the data. Capped by TPMS_SURVEY_CAP.
        if (tpmsSurveyMode) {
            val tpms = isTpmsLike(result)
            // TPMS frames bypass the survey cap so they're never dropped; the cap
            // only bounds the noisy non-TPMS neighbourhood capture.
            if (!tpms && tpmsSurveyCount.get() >= TPMS_SURVEY_CAP) return
            diagTpmsSeen++
            diagTpmsLastSeenMs = System.currentTimeMillis()
            if (tpms) {
                noteTpmsPeerSeen(result)
                noteTpmsPhase(result.device.address)
            }
            // Throttle per MAC so co-located sensors that share a BLE name
            // (e.g. front/rear TPMS both advertising "JH.TPMS") are captured
            // as distinct rows instead of collapsing onto one throttle key.
            if (!throttleTpms(result)) return
            val key = record.deviceName ?: result.device.address
            enqueueTpms(result, key, survey = true, isTpms = tpms)
            return
        }

        if (tpmsCapturePrefixes.isEmpty()) return

        // Match by name prefix, raw-PDU token, or a known TPMS manufacturer
        // company ID — the last is what catches nameless data frames (only a
        // 0xFF manufacturer record, no device name).
        if (!isTpmsLike(result)) return

        diagTpmsSeen++
        diagTpmsLastSeenMs = System.currentTimeMillis()
        noteTpmsPeerSeen(result)
        noteTpmsPhase(result.device.address)
        if (!throttleTpms(result)) return
        val key = record.deviceName ?: result.device.address
        enqueueTpms(result, key, survey = false, isTpms = true)
    }

    /** Learn each wheel's own beacon phase; front and rear are intentionally independent. */
    private fun noteTpmsPhase(mac: String) {
        val now = SystemClock.elapsedRealtime()
        val previous = tpmsLastSeenElapsed.put(mac, now)
        if (previous != null) {
            val observed = now - previous
            if (observed in TPMS_MIN_PERIOD_MS..TPMS_MAX_PERIOD_MS) {
                val old = tpmsPeriodMs[mac] ?: observed
                // Slow EWMA follows real drift without chasing one delayed callback.
                tpmsPeriodMs[mac] = ((old * 3L) + observed) / 4L
            }
        }
        tpmsNextDueElapsed[mac] = now + (tpmsPeriodMs[mac] ?: TPMS_DEFAULT_PERIOD_MS)
    }

    private fun tpmsPayloadKey(record: android.bluetooth.le.ScanRecord): String? {
        val manu = record.manufacturerSpecificData ?: return null
        for (i in 0 until manu.size()) {
            val id = manu.keyAt(i)
            if (id == ScannerPolicy.TPMS_MANUFACTURER_ID) {
                val value = manu.valueAt(i) ?: return null
                return "%04X:%s".format(id, toHex(value))
            }
        }
        return null
    }

    private fun noteTpmsPeerSeen(result: ScanResult) {
        val mac = result.device.address.uppercase()
        val now = System.currentTimeMillis()
        val payload = tpmsPayloadKey(result.scanRecord ?: return)
        val stats = tpmsPeerStats.computeIfAbsent(mac) { TpmsPeerStats() }
        synchronized(stats) {
            stats.lastSeenMs = now
            stats.seenCount++
            stats.lastRssi = result.rssi
            if (payload != null && payload != stats.lastPayload) {
                stats.lastPayloadChangeMs = now
                stats.lastPayload = payload
            }
        }
        updateTpmsPeerSummary()
    }

    /** Per-device, payload-aware throttle; true means this capture may proceed. */
    private fun throttleTpms(result: ScanResult): Boolean {
        val mac = result.device.address.uppercase()
        val nowMs = System.currentTimeMillis()
        val payload = tpmsPayloadKey(result.scanRecord ?: return false) ?: "MAC:$mac"
        val state = tpmsThrottle.computeIfAbsent(mac) { TpmsThrottleState() }
        val stats = tpmsPeerStats.computeIfAbsent(mac) { TpmsPeerStats() }
        synchronized(state) {
            val allowed = ScannerPolicy.shouldCaptureTpms(
                lastPayload = state.lastPayload,
                lastCapturedAtMs = state.lastCaptureMs,
                payload = payload,
                nowMs = nowMs,
                samePayloadIntervalMs = TPMS_CAPTURE_SAME_PAYLOAD_MS,
                changedPayloadIntervalMs = TPMS_CAPTURE_CHANGED_PAYLOAD_MS,
            )
            if (!allowed) {
                synchronized(stats) {
                    stats.lastDropReason = if (state.lastPayload == payload) {
                        "identical_payload_throttled"
                    } else {
                        "changed_payload_rate_limited"
                    }
                }
                updateTpmsPeerSummary()
            }
            return allowed
        }
    }

    private fun markTpmsEnqueued(result: ScanResult) {
        val mac = result.device.address.uppercase()
        val now = System.currentTimeMillis()
        val payload = tpmsPayloadKey(result.scanRecord ?: return) ?: "MAC:$mac"
        val state = tpmsThrottle.computeIfAbsent(mac) { TpmsThrottleState() }
        synchronized(state) {
            state.lastCaptureMs = now
            state.lastPayload = payload
        }
        val stats = tpmsPeerStats.computeIfAbsent(mac) { TpmsPeerStats() }
        synchronized(stats) {
            stats.lastEnqueuedMs = now
            stats.enqueuedCount++
            stats.lastDropReason = ""
        }
        updateTpmsPeerSummary()
    }

    private fun updateTpmsPeerSummary() {
        diagTpmsPeerSummary = tpmsPeerStats.entries
            .sortedBy { it.key }
            .take(8)
            .joinToString(",") { (mac, stats) ->
                synchronized(stats) {
                    "${maskMac(mac)}:seen=${stats.seenCount},enq=${stats.enqueuedCount},rssi=${stats.lastRssi},seenAge=${ageSeconds(stats.lastSeenMs)}s,enqAge=${ageSeconds(stats.lastEnqueuedMs)}s,changeAge=${ageSeconds(stats.lastPayloadChangeMs)}s" +
                        (if (stats.lastDropReason.isNotBlank()) ",drop=${stats.lastDropReason}" else "")
                }
            }
    }

    /**
     * Compact heartbeat-safe diagnostics. The server keeps only 200 chars of
     * ble_status, so this deliberately puts scan health, failure, per-peer
     * TPMS ages and environment age into a short ASCII prefix. MACs are reduced
     * to their last four hex digits; no complete device identity leaves the
     * relay.
     */
    fun compactDiagLine(): String {
        fun age(ms: Long): String = if (ms <= 0L) "-" else {
            ((System.currentTimeMillis() - ms).coerceAtLeast(0L) / 1000L).toString()
        }
        val scanState = when {
            diagScanState.contains("扫描中") -> "RUN"
            diagScanState.contains("重启") -> "RESTART"
            diagScanState.contains("失败") -> "FAIL"
            else -> "IDLE"
        }
        val failure = if (diagLastFailureCode == 0) "-" else {
            "${diagLastFailureCode}/${diagLastFailureName}"
        }
        val peers = tpmsPeerStats.entries
            .sortedBy { it.key }
            .take(2)
            .joinToString(",") { (mac, stats) ->
                val suffix = mac.replace(":", "").takeLast(4)
                val seenAge = synchronized(stats) { age(stats.lastSeenMs) }
                "$suffix:$seenAge"
            }
            .ifBlank { "-" }
        val env = "ENV=raw$diagEnvRawScanSeen/f$diagEnvFilterSeen" +
            "/u$diagEnvServiceUuidHits/d$diagEnvServiceDataHits/r$diagEnvLastRssi" +
            "/ok$diagEnvParseOk/x$diagEnvParseFail" +
            "/m$diagEnvMacMatches,$diagEnvMacMismatches/e$diagEnqueued" +
            "/a${age(diagEnvLastEnqueuedMs)}" +
            (if (diagEnvLastParseFailure.isBlank()) "" else "/lf${diagEnvLastParseFailure.take(12)}")
        return "SCN=$scanState/${if (diagFiltered) "F" else "U"}" +
            "/${diagFilterCount}/g$diagScanGeneration/r${age(diagLastScanResultMs)}/f$failure " +
            "$env TPMS=$peers"
    }

    private fun maskMac(mac: String): String =
        if (mac.length >= 8) mac.take(5) + "…" + mac.takeLast(5) else "masked"

    /** Build the capture JSON from a ScanResult and enqueue it (counts a capture). */
    private fun enqueueTpms(result: ScanResult, sensorName: String, survey: Boolean, isTpms: Boolean = false) {
        // TPMS frames have their own (much higher) cap so a long ride can't be
        // truncated; the survey cap is reserved for the noisy neighbourhood.
        if (isTpms && tpmsDedicatedCount.get() >= TPMS_DEDICATED_CAP) return
        val record = result.scanRecord ?: return
        val raw = record.bytes ?: return
        val mac = result.device.address

        // Manufacturer-specific data: SparseArray<companyId, bytes>.
        val manu = JSONObject()
        val manuData = record.manufacturerSpecificData
        if (manuData != null) {
            for (i in 0 until manuData.size()) {
                val cid = manuData.keyAt(i)
                val b = manuData.valueAt(i) ?: continue
                manu.put("%04X".format(cid), toHex(b))
            }
        }

        // Service data: iterate advertised UUIDs (no flat map accessor exists).
        val svc = JSONObject()
        val uuids = record.serviceUuids
        if (uuids != null) {
            for (u in uuids) {
                val b = record.getServiceData(u) ?: continue
                svc.put(u.uuid.toString(), toHex(b))
            }
        }

        // Co-located sensors can share a BLE name (front/rear TPMS both advertise
        // "JH.TPMS"). Suffix a short MAC tail so they stay distinguishable in the
        // store / dashboard, and always record the raw MAC for grouping.
        val distinctName = if (sensorName == mac) mac
        else "$sensorName#${mac.replace(":", "").takeLast(4)}"

        val json = JSONObject().apply {
            put("sensor_name", distinctName)
            put("mac", mac)
            put("rssi", result.rssi)
            put("raw_bytes", Base64.encodeToString(raw, Base64.NO_WRAP))
            put("manufacturer_data", manu)
            put("service_data", svc)
            put("captured_at", nowIsoUtc())
            if (survey) put("survey", true)
        }.toString()

        val id = store.enqueue(RelayStore.KIND_TPMS_CAPTURE, json)
        if (id > 0) {
            diagTpmsEnqueued++
            diagTpmsLastEnqueuedMs = System.currentTimeMillis()
            if (survey && !isTpms) tpmsSurveyCount.incrementAndGet()
            if (isTpms) {
                markTpmsEnqueued(result)
                tpmsDedicatedCount.incrementAndGet()
                diagTpmsDedicatedEnqueued++
            }
            // TPMS is independent of the BMS frame cadence. Without this
            // callback a parked relay waited for the periodic heartbeat/fallback
            // drain before shipping a newly observed tyre frame, which could
            // leave the dashboard stale for several minutes. The callback only
            // kicks the existing single-flight uploader; it does not create a
            // second upload path or alter the durable outbox semantics.
            try { onTpmsCaptureEnqueued?.invoke() } catch (_: Throwable) { }
        }
    }

    /** Hex-encode a byte array (uppercase, no separators). */
    private fun toHex(b: ByteArray): String =
        buildString(b.size * 2) {
            for (byte in b) append("%02X".format(byte.toInt() and 0xFF))
        }

    /**
     * Decode the pvvx "Custom" advertising payload carried in the 0x181A
     * service-data record. Layout per the upstream `adv_custom_t` struct
     * (the 1-byte size / 1-byte AD-type / 2-byte UUID header is already
     * stripped by [android.bluetooth.le.ScanRecord.getServiceData]):
     *
     *   bytes 0-5  : MAC, **little-endian** — `MAC[0]` is the LOW digit pair,
     *                so it must be reversed to match the printed address.
     *   bytes 6-7  : temperature,     int16  LE, * 0.01 °C
     *   bytes 8-9  : humidity,        uint16 LE, * 0.01 %
     *   bytes 10-11: battery voltage, uint16 LE, mV
     *   byte  12   : battery level, 0..100 %
     *   byte  13   : frame counter
     *   byte  14   : GPIO_TRG flags
     *
     * Total 15 bytes. The older atc1441 format also rides on 0x181A but is
     * 13 bytes with different scaling, so the exact length check doubles as a
     * format guard — decoding an atc1441 frame with these offsets would emit
     * plausible-looking garbage.
     */
    private fun parse(data: ByteArray, rssi: Int): Reading? {
        return when (val result = EnvPayloadParser.decode(data)) {
            is EnvPayloadParser.Outcome.Failure -> {
                diagLastBadLen = data.size
                diagEnvParseFail++
                diagEnvLastParseFailure = result.reason
                null
            }
            is EnvPayloadParser.Outcome.Success -> Reading(
                sensorMac = result.value.sensorMac,
                tempC = result.value.tempC,
                humidityPct = result.value.humidityPct,
                sensorBatteryMv = result.value.sensorBatteryMv,
                rssi = rssi,
                capturedAtIso = nowIsoUtc(),
            )
        }
    }

    private fun nowIsoUtc(): String {
        val sdf = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
        sdf.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return sdf.format(java.util.Date())
    }

    /**
     * Throttle uploads: enqueue only when at least [MIN_INTERVAL_MS] elapsed AND
     * the reading moved beyond the delta thresholds. Keeps the outbox small while
     * still capturing real changes promptly.
     */
    private fun maybeEnqueue(r: Reading) {
        val now = System.currentTimeMillis()
        val changed = lastTempC.isNaN() ||
            kotlin.math.abs(r.tempC - lastTempC) >= DELTA_TEMP_C ||
            kotlin.math.abs(r.humidityPct - lastHumPct) >= DELTA_HUM_PCT ||
            kotlin.math.abs(r.sensorBatteryMv - lastBattMv) >= DELTA_BATT_MV
        val due = now - lastUploadMs >= MIN_INTERVAL_MS

        if (!changed && !due) return

        val json = JSONObject().apply {
            put("sensor_mac", r.sensorMac)
            put("temp_c", r.tempC)
            put("humidity_pct", r.humidityPct)
            put("sensor_battery_mv", r.sensorBatteryMv)
            put("rssi", r.rssi)
            put("captured_at", r.capturedAtIso)
        }.toString()

        val id = store.enqueue(RelayStore.KIND_ENV, json)
        if (id > 0) {
            diagEnqueued++
            lastUploadMs = now
            lastTempC = r.tempC
            lastHumPct = r.humidityPct
            lastBattMv = r.sensorBatteryMv
            diagEnvLastEnqueuedMs = System.currentTimeMillis()
            try { onEnvEnqueued?.invoke() } catch (_: Throwable) { }
        }
    }
}
