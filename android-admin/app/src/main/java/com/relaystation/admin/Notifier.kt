package com.relaystation.admin

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object Notifier {
    const val CHANNEL_DUTY = "duty"
    const val CHANNEL_ORDER = "orders"
    const val ID_DUTY = 21
    const val ID_ORDER = 22

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_DUTY, "值班心跳", NotificationManager.IMPORTANCE_LOW)
        )
        val order = NotificationChannel(CHANNEL_ORDER, "充值订单", NotificationManager.IMPORTANCE_HIGH)
        order.enableVibration(true)
        order.vibrationPattern = longArrayOf(0, 180, 80, 180, 80, 360)
        nm.createNotificationChannel(order)
    }

    fun dutyNotification(ctx: Context) = NotificationCompat.Builder(ctx, CHANNEL_DUTY)
        .setSmallIcon(R.drawable.ic_launcher)
        .setContentTitle("中转站值班中")
        .setContentText("有人提交充值会震动提醒")
        .setContentIntent(openApp(ctx))
        .setOngoing(true)
        .setSilent(true)
        .build()

    fun notifyOrder(ctx: Context, title: String, body: String) {
        ensureChannels(ctx)
        vibrate(ctx)
        val n = NotificationCompat.Builder(ctx, CHANNEL_ORDER)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx))
            .setVibrate(longArrayOf(0, 180, 80, 180, 80, 360))
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(ID_ORDER, n)
        } catch (_: SecurityException) { /* permission */ }
    }

    private fun openApp(ctx: Context): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(ctx, 1, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun vibrate(ctx: Context) {
        val pattern = longArrayOf(0, 180, 80, 180, 80, 360)
        if (Build.VERSION.SDK_INT >= 31) {
            val vm = ctx.getSystemService(VibratorManager::class.java)
            vm?.defaultVibrator?.vibrate(VibrationEffect.createWaveform(pattern, -1))
        } else {
            @Suppress("DEPRECATION")
            val v = ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            v.vibrate(VibrationEffect.createWaveform(pattern, -1))
        }
    }
}
