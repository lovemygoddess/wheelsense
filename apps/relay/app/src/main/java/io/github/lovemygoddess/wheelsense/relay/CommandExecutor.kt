package io.github.lovemygoddess.wheelsense.relay

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.app.PendingIntent
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Pulls pending remote commands from the server and executes them on the relay
 * phone. Only "photo" is implemented for now; the higher-risk commands
 * (shutdown / reboot) are intentionally deferred.
 *
 *  - poll / result are RelayAuth-signed (token + HMAC over the raw JSON body),
 *    exactly like the batch uploader.
 *  - photo upload is multipart with Bearer-only auth (the server's chosen
 *    trade-off for binary bodies — it cannot HMAC the raw multipart stream).
 *
 * The whole thing is deliberately resilient: any failure ends the command as
 * `failed` rather than throwing, so a bad command can never wedge the relay.
 */
class CommandExecutor(
    private val ctx: Context,
    private val deviceSn: String,
    private val token: String,
    private val hmacSecret: String,
    private val apiBase: String,
) {

    var onStatus: ((String) -> Unit)? = null

    companion object {
        private const val POLL_INTERVAL_MS = 15_000L
        private const val ACTIVE_POLL_MAX_MS = 15_000L
        private const val OFFLINE_POLL_INTERVAL_MS = 2 * 60_000L
        private const val CONFIG_REFRESH_MS = 5 * 60_000L
        private const val POLL_PATH = "/api/relay/commands/poll"
        private const val RESULT_PATH = "/api/relay/commands/%d/result"
        private const val PHOTO_PATH = "/api/relay/photo"
        private const val CONFIG_PATH = "/api/relay/config"
        private const val APK_PATH = "/api/relay/apk"
    }

    /**
     * Server-configurable check-in cadence (relay ↔ server poll for commands /
     * config). Default 15 s; the dashboard's "轮询间隔" setting drives this via
     * RelayConfigController.effective().poll_ms. Re-read every cycle, so a config
     * change applies on the very next poll.
     */
    @Volatile var pollIntervalMs: Long = POLL_INTERVAL_MS
    @Volatile var activeMode: Boolean = false

    /** Relay pulls its remote config on every poll cycle. */
    var onConfig: ((Map<String, Any?>) -> Unit)? = null

    /** Service-level commands the relay APK can't fulfil itself (flush / clear / restart). */
    var onCommand: ((String) -> Unit)? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val worker = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var running = false
    private var lastConfigFetchAt = 0L
    private var lastPhotoUploadError = "upload_failed"

    /** In-memory dedup. poll only returns a command once (pending->dispatched),
     *  but guard against any re-delivery anyway. */
    private val handledIds = mutableSetOf<Long>()
    private val claimTokens = java.util.concurrent.ConcurrentHashMap<Long, String>()

    private val pollRunnable: Runnable = object : Runnable {
        override fun run() {
            worker.execute {
                val online = isOnline()
                try {
                    if (online) pollOnce()
                } catch (_: Throwable) {
                }
                val configured = pollIntervalMs
                val delay = if (online) {
                    if (activeMode) minOf(configured, ACTIVE_POLL_MAX_MS) else configured
                } else OFFLINE_POLL_INTERVAL_MS
                if (running) mainHandler.postDelayed(pollRunnable, delay)
            }
        }
    }

    fun start() {
        running = true
        mainHandler.postDelayed(pollRunnable, pollIntervalMs)
    }

    fun stop() {
        running = false
        mainHandler.removeCallbacksAndMessages(null)
        worker.shutdownNow()
    }

    /** Called by the connectivity owner when a validated network appears. */
    fun requestPollNow() {
        if (!running) return
        mainHandler.removeCallbacks(pollRunnable)
        mainHandler.post(pollRunnable)
    }

    private fun isOnline(): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun pollOnce() {
        if (!isOnline()) return
        val body = JSONObject().put("device_sn", deviceSn).toString()
        val resp = postJson(apiBase + POLL_PATH, body, signed = true) ?: return
        val root = try {
            JSONObject(resp)
        } catch (_: Throwable) {
            return
        }
        val cmds = root.optJSONObject("commands")?.optJSONArray("commands") ?: return
            for (i in 0 until cmds.length()) {
            val c = cmds.optJSONObject(i) ?: continue
            val id = c.optLong("id", -1)
            val command = c.optString("command", "")
            val payload = c.optJSONObject("payload")
            val claimToken = c.optString("claim_token", "")
            if (id < 0 || claimToken.isBlank() || handledIds.contains(id)) continue
            handledIds.add(id)
            claimTokens[id] = claimToken
            worker.execute { execute(id, command, payload) }
        }
        // Configuration changes rarely. Pulling it on every command check
        // doubled radio/CPU work, so refresh it independently every five minutes.
        val now = android.os.SystemClock.elapsedRealtime()
        if (lastConfigFetchAt == 0L || now - lastConfigFetchAt >= CONFIG_REFRESH_MS) {
            fetchConfigOnce()
            lastConfigFetchAt = now
        }
    }

    /**
     * Pull the device's remote config (sampling cadence / low-power / thermo MAC)
     * and hand it to the service. Fails closed — any error just means "keep the
     * current config".
     */
    private fun fetchConfigOnce() {
        val body = JSONObject().put("device_sn", deviceSn).toString()
        val resp = postJson(apiBase + CONFIG_PATH, body, signed = true) ?: return
        val root = try {
            JSONObject(resp)
        } catch (_: Throwable) {
            return
        }
        val cfg = root.optJSONObject("config") ?: return
        val map = HashMap<String, Any?>()
        map["idle_ms"] = (cfg.opt("idle_ms") as? Number)?.toLong()
        map["ride_ms"] = (cfg.opt("ride_ms") as? Number)?.toLong()
        map["poll_ms"] = (cfg.opt("poll_ms") as? Number)?.toLong()
        map["upload_ms"] = (cfg.opt("upload_ms") as? Number)?.toLong()
        map["monitor_secs"] = (cfg.opt("monitor_secs") as? Number)?.toLong()
        map["low_power"] = if (cfg.has("low_power")) cfg.optBoolean("low_power") else null
        map["power_bank_keepalive_enabled"] = if (cfg.has("power_bank_keepalive_enabled")) {
            cfg.optBoolean("power_bank_keepalive_enabled")
        } else {
            null
        }
        // Key presence matters: a config document that simply omits thermo_mac
        // must NOT be read as "disable the thermo". Only when the key is
        // explicitly present do we hand it down (empty string = disable).
        if (cfg.has("thermo_mac")) {
            map["thermo_mac"] = cfg.optString("thermo_mac", "").takeIf { it.isNotBlank() }
        }
        onConfig?.invoke(map)
    }

    private fun execute(id: Long, command: String, payload: JSONObject?) {
        when (command) {
            "photo" -> doPhoto(id, payload)
            // Remote-control primitives (rooted relay only): run a shell command,
            // inject taps / swipes / key events, or capture the screen. They all
            // go through `su -c` so they work headless in the tail box.
            "tap" -> doTap(id, payload)
            "swipe" -> doSwipe(id, payload)
            "key" -> doKey(id, payload)
            "screencap" -> doScreencap(id)
            // Service-level actions: the relay APK hands them to BmsRelayService,
            // which owns the uploader / store / service lifecycle.
            "flush", "clear-backlog", "restart" -> {
                onCommand?.invoke(command)
                reportResult(id, "done")
            }
            // 断电/重启整机：尾箱手机彻底卡死时远程拉活。需 root（Magisk 给本 App
            // 「总是允许」）。命令触发后设备随即重启，result 回报可能来不及发出，
            // 属正常（命令状态停在 dispatched 即可，不影响实际重启）。
            "reboot" -> {
                val (ok, out) = runRoot("reboot")
                if (ok) reportResult(id, "done") else reportResult(id, "reboot_failed:$out".take(200))
            }
            "shutdown" -> {
                val (ok, out) = runRoot("reboot -p")
                if (ok) reportResult(id, "done") else reportResult(id, "shutdown_failed:$out".take(200))
            }
            "update_apk" -> doUpdateApk(id)
            else -> reportResult(id, "unsupported_command:$command")
        }
    }

    /**
     * Run a shell command as root. stderr is merged into stdout (`2>&1`) so a
     * single stream read can't deadlock on a full pipe. Returns (exitOk, output).
     * Only meaningful on a rooted device — if `su` is missing the pair is
     * (false, "su_unavailable") and the caller reports failure.
     *
     * The stream is drained on a side thread and waitFor() comes FIRST: a
     * pending Magisk grant dialog keeps `su` alive with the pipe open forever,
     * so a blocking readText() before waitFor() would park the command thread
     * permanently and silently wedge the whole remote-control path.
     *
     * `internal` because BmsRelayService reuses it for BLE stack recovery —
     * there is no second place in the app that knows how to shell out safely.
     */
    internal fun runRoot(cmd: String): Pair<Boolean, String> {
        return try {
            val proc = Runtime.getRuntime().exec(arrayOf("su", "-c", "$cmd 2>&1"))
            val out = java.util.concurrent.atomic.AtomicReference("")
            val drain = kotlin.concurrent.thread(start = true, isDaemon = true) {
                try { out.set(proc.inputStream.bufferedReader().readText()) } catch (_: Throwable) { }
            }
            val finished = proc.waitFor(30, TimeUnit.SECONDS)
            if (!finished) {
                proc.destroy()
                Pair(false, "timeout")
            } else {
                drain.join(2_000)
                Pair(proc.exitValue() == 0, out.get().trim())
            }
        } catch (_: Throwable) {
            Pair(false, "su_unavailable")
        }
    }

    /** Arbitrary shell command (`payload.cmd`). Output returned to the dashboard. */
    private fun doShell(id: Long, payload: JSONObject?) {
        val cmd = payload?.optString("cmd")?.takeIf { it.isNotBlank() }
        if (cmd == null) {
            reportResult(id, "missing_cmd")
            return
        }
        val (ok, out) = runRoot(cmd)
        if (ok) reportSuccess(id, out.take(4000))
        else reportResult(id, "shell_failed:$out".take(200))
    }

    /** Tap at (x, y) in pixels (`payload.x`, `payload.y`). */
    private fun doTap(id: Long, payload: JSONObject?) {
        val x = payload?.opt("x") as? Number
        val y = payload?.opt("y") as? Number
        if (x == null || y == null) {
            reportResult(id, "missing_x_y")
            return
        }
        val (ok, out) = runRoot("input tap ${x.toInt()} ${y.toInt()}")
        if (ok) reportSuccess(id, out)
        else reportResult(id, "tap_failed:$out".take(200))
    }

    /** Swipe from (x1,y1) to (x2,y2) over `duration_ms` (`payload.*`). */
    private fun doSwipe(id: Long, payload: JSONObject?) {
        val x1 = payload?.opt("x1") as? Number; val y1 = payload?.opt("y1") as? Number
        val x2 = payload?.opt("x2") as? Number; val y2 = payload?.opt("y2") as? Number
        if (x1 == null || y1 == null || x2 == null || y2 == null) {
            reportResult(id, "missing_coords")
            return
        }
        val dur = (payload?.opt("duration_ms") as? Number)?.toInt() ?: 300
        val (ok, out) = runRoot(
            "input swipe ${x1.toInt()} ${y1.toInt()} ${x2.toInt()} ${y2.toInt()} ${dur.coerceAtLeast(0)}"
        )
        if (ok) reportSuccess(id, out)
        else reportResult(id, "swipe_failed:$out".take(200))
    }

    /** Inject a key event (`payload.code`, e.g. "KEYCODE_HOME" or "26"). */
    private fun doKey(id: Long, payload: JSONObject?) {
        val code = payload?.optString("code")?.takeIf { it.isNotBlank() }
        if (code == null) {
            reportResult(id, "missing_code")
            return
        }
        val (ok, out) = runRoot("input keyevent $code")
        if (ok) reportSuccess(id, out)
        else reportResult(id, "key_failed:$out".take(200))
    }

    /**
     * Capture the screen (root `screencap`) and upload it exactly like the
     * `photo` command with facing=screen. The server closes the command as done
     * and writes photo_url into the result.
     */
    private fun doScreencap(id: Long) {
        val file = try {
            captureScreenshot()
        } catch (_: Throwable) {
            null
        }
        if (file == null) {
            reportResult(id, "capture_failed")
            return
        }
        val url = uploadPhoto(id, file)
        try {
            file.delete()
        } catch (_: Throwable) {
        }
        if (url != null) onStatus?.invoke("截屏已上传")
        else reportResult(id, lastPhotoUploadError.take(200))
    }

    /**
     * Self-update: pull the latest relay APK from the server (RelayAuth-signed
     * GET — empty body, so the HMAC covers "") and install it.
     *
     * Install order:
     *   1. If the device is rooted, shell `su pm install -r` — fully silent on
     *      every OEM/Android version, no confirmation dialog can ever block a
     *      tail-box phone with nobody watching. Also bypasses the
     *      "install from this source" grant.
     *   2. Otherwise fall back to PackageInstaller. On Android 8+ this needs the
     *      user to grant "install from this source" once; InstallStatusReceiver
     *      catches success/failure (or a confirm prompt via
     *      STATUS_PENDING_USER_ACTION).
     */
    private fun doUpdateApk(id: Long) {
        onStatus?.invoke("正在下载更新包…")
        val dest = File(ctx.filesDir, "relay_update.apk")
        try {
            dest.delete()
        } catch (_: Throwable) {
        }
        if (!downloadApk(apiBase + APK_PATH, dest)) {
            reportResult(id, "download_failed")
            return
        }
        onStatus?.invoke("下载完成，开始安装…")
        // Root path skips the permission gate entirely; only the PackageInstaller
        // fallback needs the user-granted "install from this source" on Android 8+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !isRooted() &&
            !ctx.packageManager.canRequestPackageInstalls()
        ) {
            reportResult(id, "need_install_permission")
            return
        }
        // B-3: the root (`su pm install`) path does NOT enforce same-signature,
        // so a hijacked/tampered APK from the server could silently replace us.
        // Fail closed with a clear reason before handing it to the installer.
        if (!signaturesMatch(dest)) {
            reportResult(id, "signature_mismatch")
            return
        }
        installApk(dest, id)
    }

    /** Best-effort: does `su` resolve at all? Used to prefer the silent root path. */
    private fun isRooted(): Boolean {
        return try {
            val p = Runtime.getRuntime().exec(arrayOf("su", "-c", "exit 0"))
            val finished = p.waitFor(10, TimeUnit.SECONDS)
            // B-7: waitFor() only reports whether the process finished in time;
            // the real "is rooted" signal is its exit code (0 == su ran).
            finished && p.exitValue() == 0
        } catch (_: Throwable) {
            false
        }
    }

    /** RelayAuth-signed GET. The body is empty, so the signature is HMAC(""). */
    private fun downloadApk(url: String, dest: File): Boolean {
        val sig = hmacHex("", hmacSecret)
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("X-Relay-Sig", sig)
                connectTimeout = 15_000
                readTimeout = 60_000
            }
            val code = conn.responseCode
            if (code !in 200..299) return false
            conn.inputStream.use { input ->
                FileOutputStream(dest).use { out -> input.copyTo(out) }
            }
            dest.length() > 0
        } catch (_: Throwable) {
            false
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Throwable) {
            }
        }
    }

    /**
     * Install our own package. Prefers a rooted shell (`su pm install -r`) which
     * is fully silent on every OEM/Android — no confirmation dialog can block a
     * tail-box phone with nobody watching. Falls back to PackageInstaller when
     * root is unavailable (or the root install definitively failed).
     */
    private fun installApk(apkFile: File, id: Long) {
        val rootErr = StringBuilder()
        when (val r = tryRootInstall(apkFile, rootErr)) {
            RootInstall.SUCCESS -> {
                // Root replaced the package out from under us; the process is
                // about to restart into the new version. Report done directly —
                // the PackageInstaller broadcast path is not used here. (注意：
                // 即使这条回报因进程被替换而没发出去，服务端也会在下次心跳靠
                // app_ver 变大自动把 update_apk 结案，不会永远停在「执行中」。)
                reportSuccess(id, "installed_root")
                return
            }
            RootInstall.FAILED -> {
                reportResult(id, "root_install_failed:${rootErr.take(200)}")
                return
            }
            RootInstall.UNAVAILABLE -> { /* fall through to PackageInstaller */ }
        }
        installViaPackageInstaller(apkFile, id)
    }

    private enum class RootInstall { SUCCESS, UNAVAILABLE, FAILED }

    /**
     * Run `su -c "pm install -r <apk>"`. Returns SUCCESS only on exit 0.
     * UNAVAILABLE means su is missing or hung (e.g. root not granted to this
     * app) — caller should fall back. FAILED means su ran but pm errored, with
     * the message captured in [errOut].
     */
    private fun tryRootInstall(apkFile: File, errOut: StringBuilder): RootInstall {
        return try {
            val proc = Runtime.getRuntime().exec(
                arrayOf("su", "-c", "pm install -r " + apkFile.absolutePath),
            )
            // Drain both streams on side threads BEFORE waiting: a hung su
            // (Magisk prompt) keeps the pipes open, so a blocking readText()
            // ahead of waitFor() would park this thread forever (same class of
            // bug as runRoot had).
            val out = java.util.concurrent.atomic.AtomicReference("")
            val err = java.util.concurrent.atomic.AtomicReference("")
            val outDrain = kotlin.concurrent.thread(start = true, isDaemon = true) {
                try { out.set(proc.inputStream.bufferedReader().readText()) } catch (_: Throwable) { }
            }
            val errDrain = kotlin.concurrent.thread(start = true, isDaemon = true) {
                try { err.set(proc.errorStream.bufferedReader().readText()) } catch (_: Throwable) { }
            }
            val finished = proc.waitFor(30, TimeUnit.SECONDS)
            if (!finished) {
                proc.destroy()
                RootInstall.UNAVAILABLE
            } else if (proc.exitValue() == 0) {
                RootInstall.SUCCESS
            } else {
                outDrain.join(2_000)
                errDrain.join(2_000)
                errOut.append((if (err.get().isBlank()) out.get() else err.get()).trim())
                RootInstall.FAILED
            }
        } catch (_: Throwable) {
            RootInstall.UNAVAILABLE
        }
    }

    /** PackageInstaller path (may surface a confirmation dialog on some OEMs). */
    private fun installViaPackageInstaller(apkFile: File, id: Long) {
        try {
            val pm = ctx.packageManager
            val installer = pm.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            val sessionId = installer.createSession(params)
            val session = installer.openSession(sessionId)
            session.openWrite("relay_update", 0, apkFile.length()).use { out ->
                apkFile.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(ctx, InstallStatusReceiver::class.java).setAction(InstallStatusReceiver.ACTION)
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val pi = PendingIntent.getBroadcast(ctx, 0, intent, flags)
            session.commit(pi.intentSender)
            // 不在这里提前回报：安装成功与否由 InstallStatusReceiver + 服务端心跳
            // 版本对账决定（成功落地后中继回报新 app_ver，服务端自动结案为 done）。
            // 若提前报 failed("install_started")，history 会误显「失败」。
        } catch (e: Throwable) {
            reportResult(id, "install_failed:${e.message}")
        }
    }

    /**
     * Confirm a downloaded update APK carries the SAME signing certificate as the
     * package currently installed. PackageInstaller would reject a mismatch too,
     * but we want to fail closed with a clear reason (and the root path wouldn't
     * reject it at all). Works on Android 8 (S7) via the deprecated GET_SIGNATURES.
     */
    private fun signaturesMatch(apk: File): Boolean {
        return try {
            val pm = ctx.packageManager
            @Suppress("DEPRECATION")
            val flag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                PackageManager.GET_SIGNING_CERTIFICATES
            else
                PackageManager.GET_SIGNATURES
            val installed = pm.getPackageInfo(ctx.packageName, flag) ?: return false
            val archive = pm.getPackageArchiveInfo(apk.absolutePath, flag) ?: return false
            val installedSigs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                installed.signingInfo?.signingCertificateHistory
            else
                @Suppress("DEPRECATION") installed.signatures
            val archiveSigs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                archive.signingInfo?.signingCertificateHistory
            else
                @Suppress("DEPRECATION") archive.signatures
            installedSigs != null && archiveSigs != null && installedSigs.contentEquals(archiveSigs)
        } catch (_: Throwable) {
            false
        }
    }

    private fun doPhoto(id: Long, payload: JSONObject?) {
        val facing = payload?.optString("facing")?.takeIf { it.isNotBlank() } ?: "back"
        val file = try {
            if (facing == "screen") captureScreenshot() else Camera2PhotoCapture.capture(ctx, facing)
        } catch (_: Throwable) {
            null
        }
        if (file == null) {
            reportResult(id, "capture_failed")
            return
        }
        val url = uploadPhoto(id, file)
        try {
            file.delete()
        } catch (_: Throwable) {
        }
        if (url != null) {
            onStatus?.invoke("拍照成功已上传")
        } else {
            reportResult(id, "upload_failed")
        }
    }

    /**
     * Root-only screenshot via `screencap`. The relay phone runs headless in the
     * scooter's tail box, so a camera photo shows the outside world, not the app
     * UI. With root (Magisk granted to this app, ideally "always allow"), we can
     * capture the screen to inspect the relay app's own status text. Returns the
     * PNG file, or null on any failure (su missing / not granted / timeout).
     */
    private fun captureScreenshot(): File? {
        val out = File(ctx.cacheDir, "relay_screenshot_${System.currentTimeMillis()}.png")
        return try {
            val proc = Runtime.getRuntime().exec(
                arrayOf(
                    "su",
                    "-c",
                    "/system/bin/screencap -p ${out.absolutePath} && chmod 0644 ${out.absolutePath}",
                )
            )
            val finished = proc.waitFor(30, TimeUnit.SECONDS)
            if (!finished) {
                proc.destroy()
                null
            } else if (out.exists() && out.length() > 0) {
                out
            } else {
                null
            }
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * Multipart/form-data upload of the JPEG. On success the server marks the
     * command done and writes photo_url into its result, so we don't need to
     * call result() again for the happy path.
     */
    private fun uploadPhoto(commandId: Long, file: File): String? {
        lastPhotoUploadError = "upload_failed"
        val boundary = "relay_boundary_${System.currentTimeMillis()}"
        val enc = "multipart/form-data; boundary=$boundary"
        val crlf = "\r\n"
        val dash = "--"
        val body = ByteArrayOutputStream()
        val wr = DataOutputStream(body)
        try {
            fun writeField(name: String, value: String) {
                wr.writeBytes(dash + boundary + crlf)
                wr.writeBytes("Content-Disposition: form-data; name=\"$name\"$crlf$crlf")
                wr.writeBytes(value + crlf)
            }
            writeField("device_sn", deviceSn)
            writeField("command_id", commandId.toString())
            writeField("claim_token", claimTokens[commandId].orEmpty())
            wr.writeBytes(dash + boundary + crlf)
            val isPng = file.name.lowercase().endsWith(".png")
            wr.writeBytes("Content-Disposition: form-data; name=\"photo\"; filename=\"${file.name}\"$crlf")
            wr.writeBytes("Content-Type: ${if (isPng) "image/png" else "image/jpeg"}$crlf$crlf")
            file.inputStream().use { it.copyTo(wr) }
            wr.writeBytes(crlf)
            wr.writeBytes(dash + boundary + dash + crlf)
            wr.flush()
        } catch (error: Throwable) {
            lastPhotoUploadError = "multipart_build:${error.javaClass.simpleName}"
            return null
        }
        val bytes = body.toByteArray()
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(apiBase + PHOTO_PATH).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", enc)
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Content-Length", bytes.size.toString())
                doOutput = true
                connectTimeout = 20_000
                readTimeout = 30_000
                setFixedLengthStreamingMode(bytes.size)
            }
            conn.outputStream.use { it.write(bytes) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val detail = try {
                    conn.errorStream?.bufferedReader()?.use { it.readText() }?.take(120).orEmpty()
                } catch (_: Throwable) { "" }
                lastPhotoUploadError = "upload_http_$code:${detail}".take(200)
                return null
            }
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            val root = JSONObject(text)
            val holder = root.optJSONObject("photo")
                ?: root.optJSONObject("data")
                ?: root
            holder.optString("url").takeIf { it.isNotBlank() }
                ?: run {
                    lastPhotoUploadError = "upload_response_missing_url:${text.take(120)}"
                    null
                }
        } catch (error: Throwable) {
            lastPhotoUploadError = "upload_exception:${error.javaClass.simpleName}:${error.message.orEmpty()}".take(200)
            null
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Throwable) {
            }
        }
    }

    /** Report commands without structured output; "done" is a successful ack. */
    private fun reportResult(id: Long, outcome: String) {
        val succeeded = outcome == "done"
        val body = JSONObject().apply {
            put("device_sn", deviceSn)
            put("claim_token", claimTokens[id].orEmpty())
            put("status", if (succeeded) "done" else "failed")
            if (!succeeded) put("error", outcome)
        }.toString()
        postJson(apiBase + RESULT_PATH.format(id), body, signed = true)
    }

    /** Report a command as done, carrying a text `output` back to the dashboard. */
    private fun reportSuccess(id: Long, output: String) {
        val body = JSONObject().apply {
            put("device_sn", deviceSn)
            put("claim_token", claimTokens[id].orEmpty())
            put("status", "done")
            put("result", JSONObject().apply { put("output", output) })
        }.toString()
        postJson(apiBase + RESULT_PATH.format(id), body, signed = true)
    }

    private fun postJson(url: String, body: String, signed: Boolean): String? {
        val sig = if (signed) hmacHex(body, hmacSecret) else ""
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
                if (signed) setRequestProperty("X-Relay-Sig", sig)
                doOutput = true
                connectTimeout = 10_000
                readTimeout = 15_000
                setFixedLengthStreamingMode(body.toByteArray(Charsets.UTF_8).size)
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) return null
            conn.inputStream.bufferedReader().use { it.readText() }
        } catch (_: Throwable) {
            null
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Throwable) {
            }
        }
    }

    private fun hmacHex(data: String, key: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8))
            .joinToString("") { b -> "%02x".format(b) }
    }
}
