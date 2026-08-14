package io.github.lovemygoddess.wheelsense

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Re-arm the widget auto-refresh alarm chain after a device reboot
 *  (alarms do not survive power-off). */
class WidgetBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            WidgetRefreshScheduler.scheduleNext(context)
        }
    }
}
