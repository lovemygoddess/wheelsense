package io.github.lovemygoddess.wheelsense

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.min

/**
 * 车辆产品图的本地缓存。
 *
 * 官方图（devices.img，九号 OSS 上的透明底 PNG，710×624）体积近 190KB，
 * 每 5 分钟渲染一次小组件不可能次次联网。策略：
 *   - 只在 URL 变化（或本地文件丢失）时后台下载一次；
 *   - 下载后裁掉四周透明边（原图上下各有大片空白，不裁的话车会很小）
 *     并缩放到 ≤480px 存成 PNG；
 *   - 渲染时从磁盘解码 + 进程内存缓存，主线程开销可忽略。
 */
object VehicleImageCache {

    private const val TAG = "NinebotWidgetImg"
    private const val FILE_NAME = "widget_vehicle.png"
    private const val MAX_W = 480

    @Volatile private var memo: Bitmap? = null

    private fun file(ctx: Context) = File(ctx.filesDir, FILE_NAME)

    /** 只能在后台线程调用（会联网）。URL 未变且文件存在时立即返回。 */
    fun ensure(ctx: Context, url: String?, prefs: SharedPreferences) {
        if (url.isNullOrBlank()) return
        val f = file(ctx)
        if (f.exists() && f.length() > 0 &&
            prefs.getString(WidgetDataModule.KEY_IMAGE_CACHED, null) == url
        ) return

        var conn: HttpURLConnection? = null
        try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 12000
                instanceFollowRedirects = true
                setRequestProperty("Accept", "image/*")
            }
            if (conn.responseCode != 200) {
                Log.w(TAG, "vehicle image HTTP ${conn.responseCode}")
                return
            }
            val raw = conn.inputStream.use { BitmapFactory.decodeStream(it) } ?: return
            val trimmed = trimTransparent(raw)
            val k = min(1f, MAX_W.toFloat() / trimmed.width)
            val out = if (k < 1f) {
                Bitmap.createScaledBitmap(
                    trimmed,
                    (trimmed.width * k).toInt().coerceAtLeast(1),
                    (trimmed.height * k).toInt().coerceAtLeast(1),
                    true
                )
            } else trimmed

            val tmp = File(ctx.filesDir, "$FILE_NAME.tmp")
            FileOutputStream(tmp).use { out.compress(Bitmap.CompressFormat.PNG, 100, it) }
            if (f.exists()) f.delete()
            if (!tmp.renameTo(f)) {
                tmp.delete()
                return
            }
            prefs.edit().putString(WidgetDataModule.KEY_IMAGE_CACHED, url).apply()
            memo = null
            Log.i(TAG, "vehicle image cached ${out.width}x${out.height}")
        } catch (e: Exception) {
            Log.w(TAG, "vehicle image fetch failed", e)
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    /** 渲染用；无缓存返回 null（此时小组件只是少一张车图，不影响其他信息）。 */
    fun load(ctx: Context): Bitmap? {
        memo?.let { if (!it.isRecycled) return it }
        val f = file(ctx)
        if (!f.exists() || f.length() <= 0) return null
        return try {
            BitmapFactory.decodeFile(f.absolutePath)?.also { memo = it }
        } catch (e: Exception) {
            Log.w(TAG, "vehicle image decode failed", e)
            null
        }
    }

    /** 裁掉四周完全透明的留白（原图上下留白约占 35%）。 */
    private fun trimTransparent(src: Bitmap): Bitmap {
        if (!src.hasAlpha()) return src
        val w = src.width
        val h = src.height
        if (w <= 0 || h <= 0 || w.toLong() * h > 4_000_000L) return src
        val px = IntArray(w * h)
        src.getPixels(px, 0, w, 0, 0, w, h)
        var minX = w; var minY = h; var maxX = -1; var maxY = -1
        for (y in 0 until h) {
            val row = y * w
            for (x in 0 until w) {
                if ((px[row + x] ushr 24) > 12) {
                    if (x < minX) minX = x
                    if (x > maxX) maxX = x
                    if (y < minY) minY = y
                    if (y > maxY) maxY = y
                }
            }
        }
        if (maxX < minX || maxY < minY) return src
        val pad = 2
        minX = (minX - pad).coerceAtLeast(0)
        minY = (minY - pad).coerceAtLeast(0)
        maxX = (maxX + pad).coerceAtMost(w - 1)
        maxY = (maxY + pad).coerceAtMost(h - 1)
        return Bitmap.createBitmap(src, minX, minY, maxX - minX + 1, maxY - minY + 1)
    }
}
