package io.github.lovemygoddess.wheelsense.relay

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * Offline-first relay service.
 *
 * Previously this streamed each BMS frame straight to the server over a SIM.
 * There is no SIM any more: the phone lives in the scooter's tail box, samples
 * continuously, and only uploads when it happens to meet the owner's hotspot.
 *
 * The single most important structural change is that **everything goes
 * through the outbox**. Online and offline are no longer separate code paths —
 * when a hotspot is present the queue simply drains within seconds of a sample
 * landing. That removes the entire class of bugs where one path works and the
 * other silently doesn't.
 */
class BmsRelayService : Service() {
    companion object {
        private const val TAG = "BmsRelayService"
        const val CHANNEL_ID = "bms_relay_channel"
        const val NOTIF_ID = 1001
        const val ACTION_FLUSH = "io.github.lovemygoddess.wheelsense.relay.FLUSH"
        const val ACTION_RECONNECT = "io.github.lovemygoddess.wheelsense.relay.RECONNECT"
        const val ACTION_RESTART = "io.github.lovemygoddess.wheelsense.relay.RESTART"

        @Volatile var isRunning = false
            private set

        @Volatile var lastStatusText: String = "未启动"
            private set

        /** Pending upload backlog, surfaced to the settings UI. */
        @Volatile var pendingRows: Long = 0
            private set

        @Volatile var ridingNow: Boolean = false
            private set

        @Volatile var boardConnected: Boolean = false
            private set

        @Volatile var latestFrameText: String = "尚未收到保护板数据"
            private set

        @Volatile var latestFrameAt: Long = 0L
            private set

        @Volatile var networkOnline: Boolean = false
            private set

        @Volatile var effectiveConfigText: String = "等待服务端配置"
            private set

        @Volatile var phonePowerText: String = "读取中"
            private set

        /** Normal parking heartbeats are sparse; faults become chatty so the
         * dashboard still detects and explains them promptly. */
        // A healthy relay reports often enough for liveness without pretending
        // that Android background delivery is real-time. Alert mode remains 60s.
        private const val HEARTBEAT_NORMAL_MS = 90_000L
        private const val HEARTBEAT_ALERT_MS = 60_000L

        /** Rate-limit degraded-BLE notifications; no automatic Bluetooth or
         * process kill is allowed because the ANT GATT link must remain alive. */
        private const val BLE_RECOVERY_MIN_INTERVAL_MS = 300_000L
    }

    private val bleManager = BleManager()
    private val mainHandler = Handler(Looper.getMainLooper())

    private lateinit var store: RelayStore
    private lateinit var uploader: BatchUploader
    private var powerEvents: PowerEventStore? = null
    private var phoneBattery: PhoneBatteryMonitor? = null
    private var powerBank: PowerBankKeepAlive? = null
    private var deviceSn: String = RelayConfig.DEFAULT_DEVICE_SN

    /** Remote-configurable sampling cadence (ms), pulled from the server. */
    @Volatile private var configuredIdleMs = 30_000L
    @Volatile private var configuredRideMs = 1_000L
    @Volatile private var configuredMonitorMs = 180_000L
    @Volatile private var lowPowerFromConfig = false
    @Volatile private var thermalLowPower = false
    @Volatile private var powerBankPowered = true
    @Volatile private var powerBankKeepAliveEnabled = RelayConfig.DEFAULT_POWER_BANK_KEEPALIVE_ENABLED
    @Volatile private var currentThermoMac: String? = null

    private var uploadProblem: String? = null
    private var activeFrameStreak = 0
    private var quietSinceElapsed = 0L

    /** Passive listener for the Xiaomi thermo-hygrometer (pvvx 0x181A). */
    private var thermo: MiThermoScanner? = null

    /** Pulls and executes remote commands (e.g. photo capture). */
    private var commandExecutor: CommandExecutor? = null

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            try {
                // Always retain the newest heartbeat. Samsung can miss the
                // validated-network callback even while the fallback uploader
                // succeeds; suppressing heartbeat creation in that state made
                // the dashboard say "relay offline" beside live board data.
                store.enqueueLatestHeartbeat(
                    bleManager.heartbeatJson(
                        pendingRows = store.pendingCount(),
                        riding = ridingNow,
                        // Relay currently has no independent GPS speed feed;
                        // keep this null rather than inventing a value. When a
                        // GPS source is added, it can be passed through here.
                        gpsSpeedMps = null,
                        uploadIntervalMs = if (::uploader.isInitialized) uploader.uploadIntervalMs else null,
                    ),
                )
                uploader.requestDrain()
                pendingRows = store.pendingCount()
                networkOnline = uploader.isOnline()
                phoneBattery?.sample()?.let {
                    val level = it.levelPct?.let { pct -> "$pct%" } ?: "电量未知"
                    val temp = it.tempC?.let { c -> " · %.1f°C".format(c) } ?: ""
                    phonePowerText = "$level · ${if (it.charging) "外部供电" else "电池供电"}$temp"
                    if ((it.tempC ?: 0f) >= 45f) {
                        updateNotif("中继手机电池 ${"%.1f".format(it.tempC)}°C，尾箱温度过高")
                    }
                    val tempC = it.tempC
                    if (tempC != null && tempC >= 43f && !thermalLowPower) {
                        thermalLowPower = true
                        bleManager.lowPowerMode = true
                        updateNotif("中继手机 ${"%.1f".format(tempC)}°C，已自动降频散热")
                    } else if (tempC != null && tempC <= 39f && thermalLowPower) {
                        thermalLowPower = false
                        bleManager.lowPowerMode = lowPowerFromConfig || !powerBankPowered
                        updateNotif("中继手机温度恢复，已恢复正常采样策略")
                    }
                }
            } catch (_: Exception) {
            }
            val alert = !boardConnected || uploadProblem != null || pendingRows > 100
            mainHandler.postDelayed(this, if (alert) HEARTBEAT_ALERT_MS else HEARTBEAT_NORMAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        installCrashHandler()
        createNotificationChannel()
        // Android 14+ 会校验 manifest 声明的每个 FGS 类型权限，15 起还限制从
        // BOOT_COMPLETED 拉起部分类型；任何拒绝都必须兜住，否则整个进程崩溃且无痕。
        try {
            startForeground(NOTIF_ID, buildNotification("正在初始化..."))
        } catch (e: Exception) {
            Log.e(TAG, "startForeground rejected, aborting service", e)
            stopSelf()
            return
        }
        isRunning = true
        lastStatusText = "正在初始化..."

        // Every init step is individually guarded: a component that throws here
        // must degrade the service, not kill the process with a bare "已停止运行"
        // on a phone nobody is watching. The failing step is surfaced in the
        // notification AND written to relay_crash.log so the root cause can be
        // pulled remotely afterwards.
        try {
            val cfg = Prefs.load(this)
            currentCfg = cfg
            powerBankKeepAliveEnabled = cfg.powerBankKeepAliveEnabled
            deviceSn = cfg.deviceSn

            store = RelayStore(this)
            powerEvents = PowerEventStore(this)
            uploader = BatchUploader(this, store).also {
                it.configure(cfg)
                it.onStatus = { msg ->
                    val wasOnline = networkOnline
                    networkOnline = it.isOnline()
                    uploadProblem = it.lastError
                    if (networkOnline && !wasOnline) commandExecutor?.requestPollNow()
                    updateNotif(msg)
                }
                it.onDrained = {
                    pendingRows = store.pendingCount()
                    networkOnline = it.isOnline()
                }
                it.start()
            }

            phoneBattery = PhoneBatteryMonitor(this).also { it.start() }
            bleManager.phoneBattery = phoneBattery

            guard("蓝牙") { setupBle(cfg) }
            guard("电源保持") { setupPowerBank() }
            guard("温湿度") { setupThermo(cfg) }
            guard("远程指令") { setupCommands(cfg) }

            mainHandler.postDelayed(heartbeatRunnable, HEARTBEAT_ALERT_MS)

            pendingRows = store.pendingCount()
            // A backlog surviving a restart is normal now, so say so rather than
            // looking like a fresh start that lost everything.
            if (pendingRows > 0) {
                updateNotif("离线缓存 $pendingRows 条待回传")
            }
        } catch (t: Throwable) {
            recordCrash("onCreate", t)
            updateNotif("初始化失败：${t.javaClass.simpleName}")
            Log.e(TAG, "service init failed, stopping", t)
            stopSelf()
        }
    }

    /** Run one init step, swallowing (and recording) any failure so the rest of
     *  the service still comes up. The step name is surfaced so the failing
     *  subsystem is identifiable from the notification alone. */
    private fun guard(step: String, block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            recordCrash("init:$step", t)
            updateNotif("$step 初始化失败：${t.javaClass.simpleName} ${t.message ?: ""}")
            Log.e(TAG, "init step '$step' failed", t)
        }
    }

    /**
     * Last-resort crash recorder. Any uncaught exception anywhere in the
     * process is appended to filesDir/relay_crash.log before the default
     * handler runs, so a tail-box crash leaves a readable trace (pull it later
     * via the `shell` command) instead of only showing "已停止运行".
     */
    private fun installCrashHandler() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, err ->
            recordCrash("uncaught[${thread.name}]", err)
            try {
                prev?.uncaughtException(thread, err)
            } catch (_: Throwable) {
            }
        }
    }

    /** Append a stack trace to the on-device crash log; never throws.
     *  Mirrors to external storage too, so the trace can be pulled via
     *  MTP/USB without root (the internal filesDir copy needs root). */
    private fun recordCrash(where: String, err: Throwable) {
        try {
            val ts = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
                .format(java.util.Date())
            val trace = "=== $ts [$where] ===\n" + Log.getStackTraceString(err) + "\n\n"
            // Bound the log: an unbounded file makes every read (UI, remote
            // pull) progressively slower. Keep the newest half once past 256 KB.
            val trimIfHuge: (File) -> Unit = { f ->
                try {
                    if (f.exists() && f.length() > 256 * 1024) {
                        val tail = f.readText().takeLast(128 * 1024)
                        f.writeText(tail)
                    }
                } catch (_: Throwable) {
                }
            }
            val internal = File(filesDir, "relay_crash.log")
            trimIfHuge(internal)
            internal.appendText(trace)
            try {
                getExternalFilesDir(null)?.let {
                    val ext = File(it, "relay_crash.log")
                    trimIfHuge(ext)
                    ext.appendText(trace)
                }
            } catch (_: Throwable) {
            }
        } catch (_: Throwable) {
        }
    }

    // ── Wiring ──────────────────────────────────────────────────

    private fun setupBle(cfg: RelayConfig) {
        bleManager.onStatusUpdate = { msg ->
            lastStatusText = msg
            updateNotif(msg)
        }

        bleManager.onBoardConnectionChanged = { connected ->
            boardConnected = connected
            updateScannerPowerProfile()
        }

        bleManager.onFrameDecoded = { frame ->
            latestFrameAt = System.currentTimeMillis()
            latestFrameText = listOfNotNull(
                frame.socPct?.let { "电量 $it%" },
                frame.totalVoltageV?.let { "%.1fV".format(it) },
                frame.currentA?.let { "%+.1fA".format(it) },
                frame.powerW?.let { "$it W" },
                frame.tempsC?.maxOrNull()?.let { "最高 %.0f°C".format(it) },
            ).joinToString(" · ").ifBlank { "已收到保护板数据" }
            updateActivityMode(frame.currentA)
        }

        bleManager.onFrameRecorded = { frame, includeHex ->
            val json = bleManager.protocol().frameToJson(
                frame,
                deviceSn,
                phoneBattery?.sample(),
                boardConnected = bleManager.boardConnected,
                isHeartbeat = false,
                includeHex = includeHex,
                riding = ridingNow,
            )
            val seq = store.enqueue(RelayStore.KIND_BMS, json)
            if (seq < 0) uploadProblem = RelayStore.lastError ?: "本地缓存写入失败"
            else if (uploadProblem?.startsWith("写入") == true) uploadProblem = null
            pendingRows = store.pendingCount()
            // Cheap when offline (returns immediately), instant when not.
            uploader.requestDrain()
        }

        bleManager.start(this, cfg)
        // Seed the BMS gate/poll cadence from the currently-known config so the
        // sliders take effect even before the first server config pull lands.
        bleManager.idleKeepaliveMs = configuredIdleMs
        bleManager.idlePollMs = configuredIdleMs
        bleManager.ridePollMs = configuredRideMs
        effectiveConfigText = "停车 ${configuredIdleMs / 1000}秒 · 活跃 ${configuredRideMs}毫秒"
    }

    private fun updateActivityMode(currentA: Float?) {
        // ANT convention: negative current is discharge, positive is charging.
        // Charging must stay on the parked cadence; treating abs(+7.8 A) as a
        // ride created a permanent 1 Hz queue while the scooter was plugged in.
        val amps = currentA ?: 0f
        val now = SystemClock.elapsedRealtime()
        if (!ridingNow) {
            activeFrameStreak = if (amps <= -2f) activeFrameStreak + 1 else 0
            if (activeFrameStreak >= 3) setActiveSampling(true)
            return
        }
        if (amps >= -0.8f) {
            if (quietSinceElapsed == 0L) quietSinceElapsed = now
            if (now - quietSinceElapsed >= configuredMonitorMs) setActiveSampling(false)
        } else {
            quietSinceElapsed = 0L
        }
    }

    private fun setActiveSampling(active: Boolean) {
        if (ridingNow == active) return
        ridingNow = active
        activeFrameStreak = 0
        quietSinceElapsed = 0L
        bleManager.rideMode = active
        commandExecutor?.activeMode = active
        updateScannerPowerProfile()
        updateNotif(if (active) "检测到放电电流，切换为骑行高频采样" else "放电结束，切换为停车省电采样")
    }

    private fun updateScannerPowerProfile() {
        val scanner = thermo ?: return
        scanner.setEconomyMode(thermalLowPower || lowPowerFromConfig || !powerBankPowered)
        when {
            ridingNow -> scanner.setHighPerformance(true)
            boardConnected -> scanner.setHighPerformance(false)
            else -> scanner.startDiscoveryBurst()
        }
    }

    /**
     * Start the relay's sole BLE scanner. It forwards every device to the BMS
     * board path and, when a thermo MAC is set, also decodes `env` rows into the
     * outbox. Nothing else here depends on it, so a failure can't take down the
     * BMS/relay paths.
     */
    /** Currently-loaded relay config; captured so [buildThermo] can read the
     *  TPMS capture prefixes when re-initialising the scanner on a remote-config
     *  change (where only the MAC, not the full config, is handed down). */
    private lateinit var currentCfg: RelayConfig

    private fun setupThermo(cfg: RelayConfig) {
        currentThermoMac = cfg.sensorMac.ifBlank { null }
        // Keep the board scan from latching onto the always-broadcasting thermo.
        bleManager.setThermoMac(currentThermoMac)
        thermo = buildThermo(currentThermoMac)
        // Surface the scanner's self-diagnostics (scan state / failure count) in
        // the heartbeat so a "scan running but 0 results" failure is visible from
        // the dashboard. diagLine() is a MiThermoScanner companion member
        // (shared across the single instance), so read it off the class.
        // Heartbeats retain only 200 characters server-side. Use the compact
        // per-peer diagnostic so BMS state, scan failures, TPMS ages and env
        // age remain visible without ADB; the full line stays local for the
        // relay UI/debug log.
        bleManager.scannerDiagProvider = { thermo?.compactDiagLine() ?: "SCN=INIT" }
        // A wedged stack shows up on either path — scanning (code=2) or
        // connecting (status 257). Both routes lead to the same recovery.
        bleManager.onStackWedged = { code -> recoverWedgedBleStack(code) }
    }

    /**
     * Build (and start) the relay's SOLE BLE scanner. It always runs — when a
     * thermo MAC is configured it also decodes env frames; when not, it simply
     * forwards every device to [BleManager.considerDevice] so the ANT board can
     * still be discovered. Running it unconditionally means the board path never
     * silently loses its only scan driver.
     */
    private fun buildThermo(mac: String?): MiThermoScanner {
        val safeMac = mac?.takeIf { it.isNotBlank() }
        return MiThermoScanner(
            ctx = this,
            store = store,
            deviceSn = deviceSn,
            sensorMac = safeMac,
            onDeviceSeen = bleManager::considerDevice,
            tpmsCapturePrefixes = currentCfg.tpmsCapturePrefixes,
            tpmsSurveyMode = currentCfg.tpmsSurveyMode,
            onTpmsCaptureEnqueued = { uploader.requestDrain() },
            onEnvEnqueued = { uploader.requestDrain() },
            knownBmsMacProvider = bleManager::knownBoardMac,
        ).also {
            it.onReading = { r ->
                // Surface the latest reading in the notification for a quick sanity
                // check without opening the dashboard.
                updateNotif("温湿度 ${"%.1f".format(r.tempC)}°C / ${"%.0f".format(r.humidityPct)}%")
            }
            it.start()
            it.setEconomyMode(thermalLowPower || lowPowerFromConfig || !powerBankPowered)
            when {
                ridingNow -> it.setHighPerformance(true)
                boardConnected -> it.setHighPerformance(false)
                else -> it.startDiscoveryBurst()
            }
        }
    }

    /** elapsedRealtime of the last BLE degradation notice, 0 if never. */
    private var lastBleRecoveryAt = 0L

    /**
     * Record BLE degradation without killing the system Bluetooth process or
     * this service. Scanner retries are serialized by [MiThermoScanner]; GATT
     * reconnect remains responsible for its own bounded recovery.
     */
    private fun recoverWedgedBleStack(errorCode: Int) {
        val now = SystemClock.elapsedRealtime()
        if (lastBleRecoveryAt != 0L && now - lastBleRecoveryAt < BLE_RECOVERY_MIN_INTERVAL_MS) {
            return
        }
        lastBleRecoveryAt = now
        Log.e(TAG, "BLE stack degraded (code=$errorCode); scanner/GATT will retry without process kill")
        updateNotif("蓝牙连接异常，正在后台重试")
    }

    /** Re-init the thermo scanner when the remote config changes its MAC. */
    private fun reinitThermo(mac: String?) {
        thermo?.stop()
        thermo = null
        currentThermoMac = mac
        // Keep the board-scan exclusion list in sync with the active thermo MAC.
        bleManager.setThermoMac(mac)
        thermo = buildThermo(mac)
        updateNotif(if (mac.isNullOrBlank()) "已关闭温湿度传感器" else "温湿度传感器已更新")
    }

    /**
     * Start the remote-command executor. It polls the server every
     * [CommandExecutor] interval and runs whatever the dashboard issues (today:
     * photo capture). Fails closed — a problem here can't take down the BMS path.
     */
    private fun setupCommands(cfg: RelayConfig) {
        commandExecutor = CommandExecutor(
            this,
            deviceSn,
            cfg.token,
            cfg.hmacSecret,
            cfg.apiBase,
        ).also {
            it.onStatus = { msg -> updateNotif(msg) }
            it.onConfig = { cfg -> onRelayConfig(cfg) }
            it.onCommand = { cmd -> onRelayCommand(cmd) }
            it.start()
        }
    }

    private fun setupPowerBank() {
        val battery = phoneBattery ?: return
        powerBank = PowerBankKeepAlive(this, battery, powerBankKeepAliveEnabled).also { pb ->
            pb.restorePowerStateBaseline(powerEvents?.lastPowerPresent())
            bleManager.powerDiagProvider = { pb.compactDiagnostics() }
            bleManager.powerBankDiagnosticsProvider = { pb.diagnostics() }
            pb.powerEventDiagnosticsProvider = { powerEvents?.compact() ?: "dc=0,da=-,dd=-,dm=-" }
            pb.onStatus = { msg -> updateNotif(msg) }
            pb.onPowerEvent = { event ->
                // The journal is bounded and synchronous so the final
                // transition survives a power cut; failures are swallowed by
                // the store and never affect the V2 worker.
                try { powerEvents?.record(event) } catch (_: Throwable) { }
            }
            pb.onPowerStateChanged = { powered ->
                powerBankPowered = powered
                // B-2: effective low-power = explicit remote config OR auto when unplugged
                bleManager.lowPowerMode = thermalLowPower || lowPowerFromConfig || !powered
                updateScannerPowerProfile()
                phonePowerText = if (powered) "外部供电" else "电池供电 · 已降频"
            }
            pb.start()
            powerEvents?.rememberPowerState(battery.sample().externalPowerPresent)
        }
    }

    // ── Remote config application ──────────────────────────────

    /** Apply a config map pulled from the server (see CommandExecutor.fetchConfigOnce). */
    private fun onRelayConfig(cfg: Map<String, Any?>) {
        (cfg["idle_ms"] as? Long)?.let {
            if (it in 1_000..3_600_000) {
                configuredIdleMs = it
                bleManager.idleKeepaliveMs = it
                bleManager.idlePollMs = it
                effectiveConfigText = "停车 ${configuredIdleMs / 1000}秒 · 活跃 ${configuredRideMs}毫秒"
            }
        }
        (cfg["ride_ms"] as? Long)?.let {
            if (it in 200..60_000) {
                configuredRideMs = it
                bleManager.ridePollMs = it
                effectiveConfigText = "停车 ${configuredIdleMs / 1000}秒 · 活跃 ${configuredRideMs}毫秒"
            }
        }
        (cfg["monitor_secs"] as? Long)?.let {
            if (it in 0..600) configuredMonitorMs = it * 1_000L
        }
        (cfg["low_power"] as? Boolean)?.let {
            lowPowerFromConfig = it
            // Low-power now reduces network/sensor work only. BleManager keeps
            // the ANT board itself alive at a safe <=30 s cadence.
            bleManager.lowPowerMode = thermalLowPower || lowPowerFromConfig || !powerBankPowered
            updateScannerPowerProfile()
        }
        (cfg["power_bank_keepalive_enabled"] as? Boolean)?.let {
            powerBankKeepAliveEnabled = it
            Prefs.setPowerBankKeepAliveEnabled(this, it)
            powerBank?.enabled = it
        }
        // 轮询：中继 ↔ 服务端拉命令/配置的频率。
        (cfg["poll_ms"] as? Long)?.let {
            if (it in 1_000..60_000) commandExecutor?.pollIntervalMs = it
        }
        // 上行节流：实时保护板帧回传节奏。
        (cfg["upload_ms"] as? Long)?.let {
            if (it in 1_000..10_000 && ::uploader.isInitialized) {
                uploader.uploadIntervalMs = it
            }
        }
        // Only react to thermo_mac when the server actually SENT the key. An
        // absent key means "not managed remotely" — treating it as null here
        // would silently shut the thermo decode off (reinit with a null MAC).
        if (cfg.containsKey("thermo_mac")) {
            val mac = cfg["thermo_mac"] as? String
            if (mac != currentThermoMac) reinitThermo(mac)
        }
    }

    /** Handle service-level remote commands forwarded from CommandExecutor. */
    private fun onRelayCommand(cmd: String) {
        when (cmd) {
            "flush" -> uploader.requestDrain()
            "clear-backlog" -> {
                store.clear()
                pendingRows = store.pendingCount()
                updateNotif("已清空离线缓存")
            }
            "restart" -> restartRelay()
        }
    }

    /** Restart the relay service via a one-shot alarm, then stop this instance. */
    private fun restartRelay() {
        var scheduled = false
        try {
            val intent = Intent(this, BmsRelayService::class.java)
            val pi = PendingIntent.getService(this, 0, intent, PendingIntent.FLAG_IMMUTABLE)
            val am = getSystemService(ALARM_SERVICE) as AlarmManager
            val at = System.currentTimeMillis() + 1500
            if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            else am.set(AlarmManager.RTC_WAKEUP, at, pi)
            scheduled = true
        } catch (_: Throwable) {
        }
        if (!scheduled) {
            updateNotif("无法安排重启，服务保持运行")
            return
        }
        updateNotif("收到重启指令，正在重启中继…")
        stopSelf()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_FLUSH -> if (::uploader.isInitialized) uploader.requestDrain(force = true)
            ACTION_RECONNECT -> bleManager.reconnectNow()
            ACTION_RESTART -> restartRelay()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        boardConnected = false
        ridingNow = false
        lastStatusText = "服务未启动"
        mainHandler.removeCallbacks(heartbeatRunnable)

        try { powerBank?.stop() } catch (_: Throwable) {
        }
        try { thermo?.stop() } catch (_: Throwable) {
        }
        try { commandExecutor?.stop() } catch (_: Throwable) {
        }
        try { phoneBattery?.stop() } catch (_: Throwable) {
        }
        // uploader is lateinit and may be unassigned if onCreate bailed early.
        if (::uploader.isInitialized) {
            try { uploader.stop() } catch (_: Throwable) {
            }
        }
        try { bleManager.stop() } catch (_: Throwable) {
        }
        // Close the SQLite handle LAST, after every producer (BLE frames,
        // thermo samples, heartbeats) and the uploader have stopped. Leaving
        // it open leaked the connection (and its WAL slot) on every restart.
        if (::store.isInitialized) {
            try { store.close() } catch (_: Throwable) {
            }
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Infrastructure ──────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val c = NotificationChannel(CHANNEL_ID, "BMS 中继", NotificationManager.IMPORTANCE_LOW)
            c.setShowBadge(false)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(c)
        }
    }

    private fun buildNotification(text: String): Notification {
        val problem = uploadProblem
        val backlog = if (pendingRows > 0) " · 待传 $pendingRows" else ""
        val line = (if (problem != null) "$text · $problem" else text) + backlog
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(if (ridingNow) "BMS 中继 · 高频采样" else "BMS 中继 · 省电驻车")
            .setContentText(line)
            .setStyle(NotificationCompat.BigTextStyle().bigText(line))
            .setSmallIcon(R.drawable.ic_relay)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotif(text: String) {
        lastStatusText = text
        mainHandler.post {
            try {
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                    .notify(NOTIF_ID, buildNotification(text))
            } catch (_: Exception) {
            }
        }
    }
}
