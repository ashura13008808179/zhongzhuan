package com.relaystation.admin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 后台震动必须走 NotificationChannel。直接调 Vibrator 在后台常被厂商拦，只当前台补充。
 * 开关用两个 channel：Android 8+ 创建后改不了 channel 震动属性。
 */
object Notifier {
    const val CHANNEL_DUTY = "duty"
    const val CHANNEL_ORDER_VIBE = "orders_vibe_v2"
    const val CHANNEL_ORDER_QUIET = "orders_quiet_v2"
    const val ID_DUTY = 21

    private val VIBE_PATTERN = longArrayOf(0, 180, 80, 180, 80, 360)

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_DUTY, "值班常驻", NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
                enableVibration(false)
                setSound(null, null)
            }
        )

        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ORDER_VIBE, "充值订单（震动）", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "购卡/充值待核对时弹出并震动，后台也生效"
                enableVibration(true)
                vibrationPattern = VIBE_PATTERN
                enableLights(true)
                setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI, attrs)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
        )

        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ORDER_QUIET, "充值订单（无震动）", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "购卡/充值待核对时弹出，不震动"
                enableVibration(false)
                vibrationPattern = longArrayOf(0)
                enableLights(true)
                setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI, attrs)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
        )
    }

    fun dutyNotification(ctx: Context): Notification {
        val vibe = Prefs(ctx).vibrateEnabled
        val hint = if (vibe) "后台监听购卡/充值，来单会通知并震动" else "后台监听购卡/充值，来单会通知（震动已关）"
        return NotificationCompat.Builder(ctx, CHANNEL_DUTY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("中转站值班中")
            .setContentText(hint)
            .setContentIntent(openApp(ctx))
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    fun refreshDuty(ctx: Context) {
        try {
            NotificationManagerCompat.from(ctx).notify(ID_DUTY, dutyNotification(ctx))
        } catch (_: SecurityException) { }
    }

    fun notifyOrder(ctx: Context, title: String, body: String, tag: String = "") {
        ensureChannels(ctx)
        val vibe = Prefs(ctx).vibrateEnabled
        val channel = if (vibe) CHANNEL_ORDER_VIBE else CHANNEL_ORDER_QUIET
        val notifId = if (tag.isNotBlank()) {
            tag.hashCode().and(0x7fffffff).let { if (it == ID_DUTY || it == 0) it + 2 else it }
        } else {
            (System.currentTimeMillis() and 0x7fffffff).toInt().let { if (it == ID_DUTY) it + 1 else it }
        }

        val builder = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setContentIntent(openApp(ctx))

        if (vibe) {
            builder.setVibrate(VIBE_PATTERN)
            builder.setDefaults(NotificationCompat.DEFAULT_SOUND or NotificationCompat.DEFAULT_VIBRATE)
            vibrateDirect(ctx)
        } else {
            builder.setVibrate(null)
            builder.setDefaults(NotificationCompat.DEFAULT_SOUND)
        }

        try {
            NotificationManagerCompat.from(ctx).notify(notifId, builder.build())
        } catch (_: SecurityException) { }
    }

    private fun openApp(ctx: Context): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(ctx, 1, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun vibrateDirect(ctx: Context) {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                val vm = ctx.getSystemService(VibratorManager::class.java) ?: return
                vm.defaultVibrator.vibrate(VibrationEffect.createWaveform(VIBE_PATTERN, -1))
            } else {
                @Suppress("DEPRECATION")
                val v = ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                v.vibrate(VibrationEffect.createWaveform(VIBE_PATTERN, -1))
            }
        } catch (_: Exception) { }
    }
}
