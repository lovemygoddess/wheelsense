package io.github.lovemygoddess.wheelsense

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import androidx.core.content.ContextCompat
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Native home-screen widget artwork. RemoteViews only hosts three bitmap
 * slices; all layout is drawn here so Samsung launchers cannot reject custom
 * views or subtly rearrange the card.
 */
object WidgetRenderer {
    const val FOOTER_DP = 40f
    const val REFRESH_DP = 52f

    enum class Theme { DARK, LIGHT }

    data class Skin(
        val primary: Int, val primarySoft: Int, val background: Int, val surface: Int,
        val surfaceSecondary: Int, val border: Int, val textPrimary: Int,
        val textSecondary: Int, val textMuted: Int, val warning: Int, val danger: Int,
        val glowOpacity: Float = 0.12f,
    )

    data class Data(
        val vehicleName: String,
        val soc: Float?,
        val rangeKm: Float?,
        val charging: Boolean,
        val updatedText: String,
        val vehicle: Bitmap?,
        val locationShort: String?,
        val frontPressureBar: Float?,
        val rearPressureBar: Float?,
        val frontTempC: Float? = null,
        val rearTempC: Float? = null,
        // 充电中才显示：实时功率（瓦）与剩余充电时间（分钟），缺省 null。
        val chargePowerW: Float? = null,
        val remainChargeMin: Float? = null,
        val isStale: Boolean = false,
        val widgetCharacter: Bitmap? = null,
        val widgetDecoration: Bitmap? = null,
        val widgetBackground: Bitmap? = null,
        val isDemo: Boolean = false,
        val characterMaxFraction: Float = 0.2f,
        val characterCropTop: Float = 0f,
        val characterCropBottom: Float = 1f,
    )

    private data class Palette(
        val top: Int,
        val bottom: Int,
        val glow: Int,
        val border: Int,
        val title: Int,
        val primary: Int,
        val secondary: Int,
        val muted: Int,
        val track: Int,
        val footerLine: Int,
        val footerChip: Int,
        val shadow: Int,
    )

    private val bold = Typeface.create("sans-serif", Typeface.BOLD)
    private val medium = Typeface.create("sans-serif-medium", Typeface.NORMAL)

    private fun palette(theme: Theme, skin: Skin?) = skin?.let {
        Palette(
            top = it.surface, bottom = it.background,
            glow = withAlpha(it.primary, (255 * it.glowOpacity.coerceIn(0f, 0.22f)).roundToInt()),
            border = it.border, title = it.textPrimary, primary = it.primary,
            secondary = it.textSecondary, muted = it.textMuted,
            track = withAlpha(it.primarySoft, if (theme == Theme.DARK) 150 else 210),
            footerLine = withAlpha(it.border, 150), footerChip = it.surfaceSecondary,
            shadow = if (theme == Theme.DARK) 0x65000000 else 0x28000000,
        )
    } ?: when (theme) {
        Theme.LIGHT -> Palette(
            top = 0xFFFFFFFF.toInt(), bottom = 0xFFF5F6F8.toInt(), glow = 0x247657F6,
            border = 0xFFE4E5EA.toInt(), title = 0xFF17151D.toInt(), primary = 0xFF7657F6.toInt(),
            secondary = 0xFF5E5A68.toInt(), muted = 0xFF777280.toInt(), track = 0xFFECE8FF.toInt(),
            footerLine = 0x99E4E5EA.toInt(), footerChip = 0xFFF0F1F5.toInt(),
            shadow = 0x30000000,
        )
        Theme.DARK -> Palette(
            top = 0xFF15121B.toInt(), bottom = 0xFF0C0A10.toInt(), glow = 0x309B82FF,
            border = 0xFF292431.toInt(), title = 0xFFF7F5FA.toInt(), primary = 0xFF9B82FF.toInt(),
            secondary = 0xFFC8C2D0.toInt(), muted = 0xFF928B9B.toInt(), track = 0xFF28203F.toInt(),
            footerLine = 0x99292431.toInt(), footerChip = 0xFF1B1723.toInt(),
            shadow = 0x65000000,
        )
    }

    fun footerPx(h: Int, s: Float): Int = (FOOTER_DP * s).toInt().coerceIn(1, h - 1)
    fun refreshPx(w: Int, s: Float): Int = (REFRESH_DP * s).toInt().coerceIn(1, w - 1)

    fun render(
        ctx: Context,
        w: Int,
        h: Int,
        s: Float,
        t: Float,
        theme: Theme,
        d: Data,
        skin: Skin? = null,
    ): Bitmap {
        val p = palette(theme, skin)
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val wf = w.toFloat()
        val hf = h.toFloat()
        val footerTop = (h - footerPx(h, s)).toFloat()
        val radius = 22f * s

        canvas.save()
        canvas.clipPath(Path().apply {
            addRoundRect(RectF(0f, 0f, wf, hf), radius, radius, Path.Direction.CW)
        })
        drawBackground(canvas, wf, hf, s, p)
        drawThemeBitmap(canvas, d.widgetBackground, RectF(0f, 0f, wf, footerTop), 90)
        drawThemeBitmap(canvas, d.widgetDecoration, RectF(0f, 0f, wf, footerTop), 115)
        val pad = 16f * t
        val titlePaint = text(p.title, 14f * t, true)
        val title = TextUtils.ellipsize(
            d.vehicleName,
            titlePaint,
            wf * 0.48f - pad,
            TextUtils.TruncateAt.END,
        ).toString()
        val titleBase = 11f * t - titlePaint.fontMetrics.ascent
        canvas.drawText(title, pad, titleBase, titlePaint)
        if (d.isDemo) {
            val demoPaint = text(p.primary, 8f * t, true).apply { textAlign = Paint.Align.RIGHT }
            canvas.drawText("DEMO", wf - pad, titleBase, demoPaint)
        }

        val bodyTop = titleBase + 7f * t
        val bodyBottom = footerTop - 6f * t
        val splitX = wf * 0.49f
        drawEnergy(ctx, canvas, pad, splitX - 11f * t, bodyTop, bodyBottom, t, d, p)

        // Scene order is intentional: Chii is background scenery and the
        // actual vehicle is drawn over her, creating a natural occlusion.
        drawCharacterDecoration(canvas, d.widgetCharacter, wf, bodyTop, bodyBottom, s, d.characterMaxFraction, d.characterCropTop, d.characterCropBottom)
        drawVehicle(
            canvas,
            d.vehicle,
            splitX,
            wf - pad - if (d.widgetCharacter != null) wf * 0.08f else 0f,
            bodyTop + 2f * t,
            bodyBottom - 15f * t,
            p,
        )
        drawLocation(canvas, splitX, wf - pad, bodyBottom, t, d.locationShort, p)
        drawFooter(ctx, canvas, wf, hf, footerTop, pad, s, d.updatedText, p)
        canvas.restore()
        return bitmap
    }

    fun slice(full: Bitmap, s: Float): Array<Bitmap> {
        val w = full.width
        val h = full.height
        val footH = footerPx(h, s)
        val heroH = h - footH
        val refW = refreshPx(w, s)
        return arrayOf(
            Bitmap.createBitmap(full, 0, 0, w, heroH),
            Bitmap.createBitmap(full, 0, heroH, w - refW, footH),
            Bitmap.createBitmap(full, w - refW, heroH, refW, footH),
        )
    }

    private fun drawBackground(c: Canvas, w: Float, h: Float, s: Float, p: Palette) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(0f, 0f, w * 0.42f, h, p.top, p.bottom, Shader.TileMode.CLAMP)
        }
        c.drawRect(0f, 0f, w, h, paint)
        paint.shader = RadialGradient(
            w * 0.75f,
            h * 0.36f,
            w * 0.52f,
            intArrayOf(p.glow, 0x00000000),
            null,
            Shader.TileMode.CLAMP,
        )
        c.drawRect(0f, 0f, w, h, paint)
        paint.shader = null
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = max(1f, s)
        paint.color = p.border
        c.drawRoundRect(RectF(0.5f, 0.5f, w - 0.5f, h - 0.5f), 22f * s, 22f * s, paint)
    }

    private fun drawEnergy(
        ctx: Context,
        c: Canvas,
        left: Float,
        right: Float,
        top: Float,
        bottom: Float,
        u: Float,
        d: Data,
        p: Palette,
    ) {
        val height = (bottom - top).coerceAtLeast(1f)
        val socText = d.soc?.takeIf { it >= 0f }?.roundToInt()?.coerceIn(0, 100)?.let { "$it%" } ?: "--%"
        val rangeText = d.rangeKm?.takeIf { it >= 0f }?.let { "%.1f km".format(it) } ?: "-- km"
        val mainColor = if (d.isStale) p.muted else socColor(d.soc, p)

        val available = (right - left).coerceAtLeast(1f)
        var socSize = min(24f * u, height * 0.27f)
        var rangeSize = min(12f * u, height * 0.145f)
        var socPaint = text(if (d.isStale) p.muted else p.title, socSize, true)
        var rangePaint = text(if (d.isStale) p.muted else p.primary, rangeSize, true)
        val wanted = socPaint.measureText(socText) + rangePaint.measureText(rangeText) + 10f * u
        if (wanted > available) {
            val scale = (available / wanted).coerceAtLeast(0.68f)
            socSize *= scale
            rangeSize *= scale
            socPaint = text(if (d.isStale) p.muted else p.title, socSize, true)
            rangePaint = text(if (d.isStale) p.muted else p.primary, rangeSize, true)
        }
        rangePaint.textAlign = Paint.Align.RIGHT
        val baseline = top - socPaint.fontMetrics.ascent
        c.drawText(socText, left, baseline, socPaint)
        c.drawText(rangeText, right, baseline, rangePaint)

        val barTop = top + height * 0.48f
        val barH = max(8f * u, height * 0.09f)
        val barRect = RectF(left, barTop, right, barTop + barH)
        c.drawRoundRect(barRect, barH / 2f, barH / 2f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = p.track })
        val pct = d.soc?.coerceIn(0f, 100f) ?: 0f
        if (pct > 0f) {
            val fill = RectF(left, barTop, left + barRect.width() * pct / 100f, barTop + barH)
            val fp = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = mainColor
                shader = LinearGradient(fill.left, 0f, max(fill.left + 1f, fill.right), 0f,
                    lighten(mainColor), mainColor, Shader.TileMode.CLAMP)
            }
            c.drawRoundRect(fill, barH / 2f, barH / 2f, fp)
        }

        // ── 电量横条下方信息带：充电行（闪电+实时功率+剩余时间）+ 前/后胎压胎温行 ──
        // 统一按行堆叠、按行数自适应行高与字号；充电行仅充电时显示，
        // 轮胎行仅 15 分钟内数据显示。行类型：0=充电、1=前轮、2=后轮。
        val bandTop = barRect.bottom + 5f * u
        val bandBottom = bottom
        val rows = mutableListOf<Int>()
        if (d.charging && !d.isStale) rows.add(0)
        if (d.frontPressureBar != null || d.frontTempC != null) rows.add(1)
        if (d.rearPressureBar != null || d.rearTempC != null) rows.add(2)

        if (rows.isNotEmpty() && bandBottom - bandTop > 6f * u) {
            val rowH = (bandBottom - bandTop) / rows.size
            val textSize = min(9f * u, rowH * 0.6f)
            val labelPaint = text(p.secondary, textSize, true)
            val valPaint = text(p.primary, textSize, true)
            val labelW = max(labelPaint.measureText("前轮"), labelPaint.measureText("后轮")) + 6f * u

            rows.forEachIndexed { i, rowKind ->
                val cy = bandTop + rowH * (i + 0.5f)
                val base = cy - (valPaint.fontMetrics.ascent + valPaint.fontMetrics.descent) / 2f
                if (rowKind == 0) {
                    // 充电行：闪电图标 + 实时功率 + 剩余充电时间。
                    var x = left
                    ContextCompat.getDrawable(ctx, R.drawable.ic_widget_flash)?.let { icon ->
                        icon.mutate()
                        icon.setTint(p.primary)
                        val size = min(13f * u, rowH * 0.7f)
                        icon.setBounds(
                            x.toInt(), (cy - size / 2f).toInt(),
                            (x + size).toInt(), (cy + size / 2f).toInt(),
                        )
                        icon.draw(c)
                        x += size + 4f * u
                    }
                    val chargeText = buildString {
                        if (d.chargePowerW != null) append("%.0fW".format(d.chargePowerW))
                        if (d.remainChargeMin != null) {
                            if (isNotEmpty()) append("  ")
                            append("剩 ").append(formatRemainMin(d.remainChargeMin))
                        }
                        if (isEmpty()) append("充电中")
                    }
                    // 超出栏宽时尾部省略，避免顶到右侧车辆图。
                    val avail = (right - x).coerceAtLeast(1f)
                    val shown = TextUtils.ellipsize(chargeText, valPaint, avail, TextUtils.TruncateAt.END).toString()
                    c.drawText(shown, x, base, valPaint)
                } else {
                    val label = if (rowKind == 1) "前轮" else "后轮"
                    val pres = if (rowKind == 1) d.frontPressureBar else d.rearPressureBar
                    val temp = if (rowKind == 1) d.frontTempC else d.rearTempC
                    c.drawText(label, left, base, labelPaint)
                    val valText = buildString {
                        append(if (pres != null) "%.2f bar".format(pres) else "-- bar")
                        if (temp != null) append("  %.0f°C".format(temp))
                    }
                    c.drawText(valText, left + labelW, base, text(tireColor(pres, if (rowKind == 1) 2.14f else 2.15f, p), textSize, true))
                }
            }
        }
    }

    /** 剩余充电时间紧凑格式：与 App 一致（<60 → "42分钟"，≥60 → "1时25分"）。 */
    private fun formatRemainMin(minutes: Float): String {
        val m = minutes.roundToInt()
        return if (m >= 60) "${m / 60}时${m % 60}分" else "${m}分钟"
    }

    private fun drawVehicle(
        c: Canvas,
        vehicle: Bitmap?,
        left: Float,
        right: Float,
        top: Float,
        bottom: Float,
        p: Palette,
    ): RectF? {
        if (vehicle == null || vehicle.isRecycled || vehicle.width <= 0 || vehicle.height <= 0) return null
        val maxW = (right - left).coerceAtLeast(1f)
        val maxH = (bottom - top).coerceAtLeast(1f)
        val scale = min(maxW / vehicle.width, maxH / vehicle.height)
        val width = vehicle.width * scale
        val height = vehicle.height * scale
        val x = left + (maxW - width) / 2f
        val y = top + (maxH - height) / 2f
        val rect = RectF(x, y, x + width, y + height)

        c.drawOval(
            RectF(x + width * 0.05f, y + height * 0.80f, x + width * 0.95f, y + height * 1.10f),
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                shader = RadialGradient(
                    rect.centerX(), y + height * 0.93f, max(1f, width * 0.46f),
                    intArrayOf(p.shadow, 0x00000000), null, Shader.TileMode.CLAMP,
                )
            },
        )
        c.drawBitmap(vehicle, null, rect, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
        return rect
    }

    /**
     * Draw the theme character as a compact avatar. The crop and size are
     * theme-driven, while the circular mask keeps the widget from showing a
     * shrunken full-body illustration.
     */
    private fun drawCharacterDecoration(c: Canvas, bitmap: Bitmap?, w: Float, bodyTop: Float, bodyBottom: Float, s: Float, requestedFraction: Float, cropTop: Float, cropBottom: Float) {
        if (bitmap == null || bitmap.isRecycled || bitmap.width <= 0 || bitmap.height <= 0) return
        val fraction = requestedFraction.coerceIn(0.1f, 0.2f)
        val maxW = w * fraction
        val top = cropTop.coerceIn(0f, 0.8f)
        val bottom = cropBottom.coerceIn(top + 0.2f, 1f).coerceAtMost(top + 0.4f)
        // Central head/ear crop: enough hair and shoulder to read as Chii,
        // without ever shrinking the full-body source into a sticker.
        val cropLeft = 0.25f
        val cropRight = 0.75f
        val src = android.graphics.Rect(
            (bitmap.width * cropLeft).roundToInt(),
            (bitmap.height * top).roundToInt(),
            (bitmap.width * cropRight).roundToInt(),
            (bitmap.height * bottom).roundToInt(),
        )
        val maxH = (bodyBottom - bodyTop).coerceAtLeast(1f) * 0.46f
        val avatarSize = min(maxW, maxH)
        val right = w - 8f * s
        val rectTop = bodyTop + 2f * s
        val rect = RectF(right - avatarSize, rectTop, right, rectTop + avatarSize)
        c.save()
        c.clipPath(Path().apply { addCircle(rect.centerX(), rect.centerY(), avatarSize / 2f, Path.Direction.CW) })
        c.drawBitmap(bitmap, src, rect, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { alpha = 248 })
        c.restore()
    }

    private fun drawThemeBitmap(c: Canvas, bitmap: Bitmap?, target: RectF, alpha: Int) {
        if (bitmap == null || bitmap.isRecycled || bitmap.width <= 0 || bitmap.height <= 0) return
        c.drawBitmap(bitmap, null, target, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { this.alpha = alpha })
    }

    private fun drawLocation(
        c: Canvas,
        left: Float,
        right: Float,
        bottom: Float,
        u: Float,
        location: String?,
        p: Palette,
    ) {
        val paint = text(p.secondary, 7.6f * u, false).apply { textAlign = Paint.Align.CENTER }
        val value = location?.takeIf { it.isNotBlank() } ?: "位置暂未上报"
        // Preserve both the street/number prefix and the concrete landmark at
        // the end. END truncation produced "展览路街道西…" and discarded the
        // useful "新动力金融科技中心" part.
        val shown = TextUtils.ellipsize(value, paint, (right - left) * 0.96f, TextUtils.TruncateAt.MIDDLE).toString()
        c.drawText(shown, (left + right) / 2f, bottom - paint.fontMetrics.descent, paint)
    }

    private fun drawFooter(
        ctx: Context,
        c: Canvas,
        w: Float,
        h: Float,
        top: Float,
        pad: Float,
        s: Float,
        updated: String,
        p: Palette,
    ) {
        c.drawRect(pad, top, w - pad, top + max(1f, 0.7f * s), Paint().apply { color = p.footerLine })
        val paint = text(p.muted, 8.3f * s, false)
        val cy = (top + h) / 2f
        val maxWidth = (w - REFRESH_DP * s - pad * 1.5f).coerceAtLeast(1f)
        val shown = TextUtils.ellipsize(updated, paint, maxWidth, TextUtils.TruncateAt.END).toString()
        c.drawText(shown, pad, cy - (paint.fontMetrics.ascent + paint.fontMetrics.descent) / 2f, paint)

        val cx = w - 26f * s
        c.drawCircle(cx, cy, 11f * s, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = p.footerChip })
        ContextCompat.getDrawable(ctx, R.drawable.ic_widget_refresh)?.let { icon ->
            icon.mutate()
            icon.setTint(p.secondary)
            val size = 13f * s
            icon.setBounds(
                (cx - size / 2f).toInt(), (cy - size / 2f).toInt(),
                (cx + size / 2f).toInt(), (cy + size / 2f).toInt(),
            )
            icon.draw(c)
        }
    }

    private fun socColor(soc: Float?, p: Palette): Int = when {
        soc == null -> p.muted
        soc <= 20f -> 0xFFEF4444.toInt()
        soc <= 45f -> 0xFFF59E0B.toInt()
        else -> p.primary
    }

    private fun tireColor(value: Float?, nominal: Float, p: Palette): Int {
        if (value == null) return p.muted
        val delta = kotlin.math.abs(value - nominal)
        return when { delta >= 0.5f -> 0xFFEF4444.toInt(); delta >= 0.3f -> 0xFFF59E0B.toInt(); else -> p.secondary }
    }

    private fun withAlpha(color: Int, alpha: Int): Int = (color and 0x00FFFFFF) or (alpha.coerceIn(0, 255) shl 24)

    private fun lighten(color: Int): Int {
        val r = min(255, ((color shr 16) and 0xFF) + 35)
        val g = min(255, ((color shr 8) and 0xFF) + 35)
        val b = min(255, (color and 0xFF) + 35)
        return (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }

    private fun text(color: Int, size: Float, isBold: Boolean): TextPaint =
        TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color
            textSize = size
            typeface = if (isBold) bold else medium
            isSubpixelText = true
        }
}
