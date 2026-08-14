package io.github.lovemygoddess.wheelsense.relay

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.io.File

class MainActivity : AppCompatActivity() {
    companion object { private const val PERM_REQUEST = 1001 }

    private lateinit var statusText: TextView
    private lateinit var serviceSubText: TextView
    private lateinit var boardText: TextView
    private lateinit var latestText: TextView
    private lateinit var modeText: TextView
    private lateinit var networkText: TextView
    private lateinit var queueText: TextView
    private lateinit var powerText: TextView
    private lateinit var configText: TextView
    private lateinit var diagText: TextView
    private lateinit var toggleBtn: Button
    private lateinit var reconnectBtn: Button
    private lateinit var flushBtn: Button
    private lateinit var advancedBtn: Button
    private lateinit var advancedPanel: LinearLayout
    private lateinit var serverUrlEdit: EditText
    private lateinit var tokenEdit: EditText
    private lateinit var hmacEdit: EditText
    private lateinit var deviceSnEdit: EditText
    private val uiHandler = Handler(Looper.getMainLooper())

    private val statusTicker = object : Runnable {
        override fun run() {
            renderStatus()
            uiHandler.postDelayed(this, 1_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        serviceSubText = findViewById(R.id.serviceSubText)
        boardText = findViewById(R.id.boardText)
        latestText = findViewById(R.id.latestText)
        modeText = findViewById(R.id.modeText)
        networkText = findViewById(R.id.networkText)
        queueText = findViewById(R.id.queueText)
        powerText = findViewById(R.id.powerText)
        configText = findViewById(R.id.configText)
        diagText = findViewById(R.id.diagText)
        toggleBtn = findViewById(R.id.toggleBtn)
        reconnectBtn = findViewById(R.id.reconnectBtn)
        flushBtn = findViewById(R.id.flushBtn)
        advancedBtn = findViewById(R.id.advancedBtn)
        advancedPanel = findViewById(R.id.advancedPanel)
        serverUrlEdit = findViewById(R.id.serverUrlEdit)
        tokenEdit = findViewById(R.id.tokenEdit)
        hmacEdit = findViewById(R.id.hmacEdit)
        deviceSnEdit = findViewById(R.id.deviceSnEdit)

        val versionName = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "—"
        } catch (_: Exception) { "—" }
        findViewById<TextView>(R.id.versionText).text =
            "v$versionName · 无人值守低功耗版"

        val cfg = Prefs.load(this)
        serverUrlEdit.setText(cfg.serverUrl)
        tokenEdit.setText(cfg.token)
        hmacEdit.setText(cfg.hmacSecret)
        deviceSnEdit.setText(cfg.deviceSn)

        toggleBtn.setOnClickListener { toggleService() }
        reconnectBtn.setOnClickListener { sendServiceAction(BmsRelayService.ACTION_RECONNECT) }
        flushBtn.setOnClickListener { sendServiceAction(BmsRelayService.ACTION_FLUSH) }
        advancedBtn.setOnClickListener {
            val show = advancedPanel.visibility != View.VISIBLE
            advancedPanel.visibility = if (show) View.VISIBLE else View.GONE
            advancedBtn.text = if (show) "收起高级设置" else "展开高级设置"
        }
        findViewById<Button>(R.id.saveBtn).setOnClickListener { saveSettings() }
        findViewById<Button>(R.id.batteryBtn).setOnClickListener { openBatteryWhitelist() }
        findViewById<Button>(R.id.cameraBtn).setOnClickListener { requestCameraPermission() }

        checkCorePermissions()
    }

    override fun onResume() {
        super.onResume()
        renderStatus()
        uiHandler.post(statusTicker)
    }

    override fun onPause() {
        uiHandler.removeCallbacks(statusTicker)
        super.onPause()
    }

    private fun renderStatus() {
        val running = BmsRelayService.isRunning
        statusText.text = if (running) "中继正在运行" else "中继未运行"
        serviceSubText.text = BmsRelayService.lastStatusText
        toggleBtn.text = if (running) "停止服务" else "启动服务"
        reconnectBtn.isEnabled = running
        flushBtn.isEnabled = running

        boardText.text = if (BmsRelayService.boardConnected) "● 保护板已连接" else "○ 保护板未连接"
        val frameAt = BmsRelayService.latestFrameAt
        val age = if (frameAt > 0) ageText(System.currentTimeMillis() - frameAt) else "无数据"
        latestText.text = "${BmsRelayService.latestFrameText}\n更新时间：$age"
        modeText.text = if (BmsRelayService.ridingNow) {
            "采样模式：活跃 · 高频记录"
        } else {
            "采样模式：停车 · 低功耗"
        }
        networkText.text = if (BmsRelayService.networkOnline) "● 网络可用" else "○ 当前离线"
        queueText.text = "本地待回传：${BmsRelayService.pendingRows} 条"
        powerText.text = "中继手机：${BmsRelayService.phonePowerText}"
        configText.text = BmsRelayService.effectiveConfigText

        val diagnostics = mutableListOf<String>()
        RelayStore.lastError?.let { diagnostics += "缓存：$it（丢失 ${RelayStore.lostSamples} 条）" }
        diagnostics += MiThermoScanner.diagLine()
        lastCrash()?.let { diagnostics += "最近崩溃：\n$it" }
        diagText.text = diagnostics.joinToString("\n")
    }

    private fun ageText(deltaMs: Long): String = when {
        deltaMs < 3_000 -> "刚刚"
        deltaMs < 60_000 -> "${deltaMs / 1_000} 秒前"
        deltaMs < 3_600_000 -> "${deltaMs / 60_000} 分钟前"
        else -> "${deltaMs / 3_600_000} 小时前"
    }

    private fun checkCorePermissions() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 31) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
                needed += Manifest.permission.BLUETOOTH_CONNECT
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED)
                needed += Manifest.permission.BLUETOOTH_SCAN
        }
        // Android 6-11 requires location permission to return unfiltered BLE scans.
        if (Build.VERSION.SDK_INT < 31 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) needed += Manifest.permission.ACCESS_FINE_LOCATION
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) needed += Manifest.permission.POST_NOTIFICATIONS
        if (needed.isNotEmpty()) ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERM_REQUEST)
    }

    private fun requestCameraPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "远程拍照权限已启用", Toast.LENGTH_SHORT).show()
        } else {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), PERM_REQUEST)
        }
    }

    private fun openBatteryWhitelist() {
        if (Build.VERSION.SDK_INT < 23) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            Toast.makeText(this, "已在电池优化白名单中", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
            )
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun saveSettings() {
        val url = serverUrlEdit.text.toString().trim()
        val token = tokenEdit.text.toString().trim()
        val hmac = hmacEdit.text.toString().trim()
        val sn = deviceSnEdit.text.toString().trim()
        if (url.isBlank() || token.isBlank() || hmac.isBlank() || sn.isBlank()) {
            Toast.makeText(this, "地址、Token、HMAC 和 SN 不能为空", Toast.LENGTH_SHORT).show()
            return
        }
        val old = Prefs.load(this)
        Prefs.save(this, old.copy(serverUrl = url, token = token, hmacSecret = hmac, deviceSn = sn))
        if (BmsRelayService.isRunning) sendServiceAction(BmsRelayService.ACTION_RESTART)
        else startRelay()
        Toast.makeText(this, "设置已保存，正在重新加载", Toast.LENGTH_SHORT).show()
    }

    private fun toggleService() {
        if (BmsRelayService.isRunning) stopService(Intent(this, BmsRelayService::class.java))
        else startRelay()
        uiHandler.postDelayed({ renderStatus() }, 500L)
    }

    private fun startRelay() {
        if (Build.VERSION.SDK_INT >= 31 &&
            (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED)
        ) {
            Toast.makeText(this, "请先授予蓝牙权限", Toast.LENGTH_SHORT).show()
            checkCorePermissions()
            return
        }
        ContextCompat.startForegroundService(this, Intent(this, BmsRelayService::class.java))
    }

    private fun sendServiceAction(action: String) {
        if (!BmsRelayService.isRunning) return
        ContextCompat.startForegroundService(this, Intent(this, BmsRelayService::class.java).setAction(action))
    }

    private var lastCrashCache: Pair<Long, String?>? = null
    private fun lastCrash(): String? {
        return try {
            val ext = getExternalFilesDir(null) ?: return null
            val f = File(ext, "relay_crash.log")
            if (!f.exists()) return null
            val mtime = f.lastModified()
            lastCrashCache?.let { if (it.first == mtime) return it.second }
            val text = f.readLines().takeLast(20).joinToString("\n")
            lastCrashCache = mtime to text
            text
        } catch (_: Throwable) { null }
    }
}
