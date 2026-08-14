package io.github.lovemygoddess.wheelsense

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import kotlin.math.max

/** Optional Theme Pack bitmap cache. Missing assets are a normal, zero-cost state. */
object WidgetThemeAssetCache {
    private val cache = LinkedHashMap<String, Bitmap>(4, 0.75f, true)

    @Synchronized
    fun load(context: Context, pathOrUri: String?, maxSidePx: Int): Bitmap? {
        val source = pathOrUri?.takeIf { it.isNotBlank() } ?: return null
        cache[source]?.takeIf { !it.isRecycled }?.let { return it }
        val decoded = if (source.startsWith("res://")) {
            val name = source.removePrefix("res://")
            val resourceId = context.resources.getIdentifier(name, "drawable", context.packageName)
            if (resourceId == 0) return null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeResource(context.resources, resourceId, bounds)
            val sample = sampleSize(bounds.outWidth, bounds.outHeight, maxSidePx)
            BitmapFactory.decodeResource(context.resources, resourceId, BitmapFactory.Options().apply { inSampleSize = sample })
        } else {
            val path = source.removePrefix("file://")
            val file = File(path)
            if (!file.isFile) return null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, bounds)
            val sample = sampleSize(bounds.outWidth, bounds.outHeight, maxSidePx)
            val decoded = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            decoded
        } ?: return null
        cache[source] = decoded
        while (cache.size > 3) {
            val oldest = cache.entries.first()
            cache.remove(oldest.key)
            if (!oldest.value.isRecycled) oldest.value.recycle()
        }
        return decoded
    }

    private fun sampleSize(width: Int, height: Int, maxSidePx: Int): Int {
        if (width <= 0 || height <= 0) return 1
        var sample = 1
        while (max(width / sample, height / sample) > maxSidePx * 2) sample *= 2
        return sample
    }
}
