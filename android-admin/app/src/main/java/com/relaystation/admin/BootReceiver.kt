package com.relaystation.admin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) return
        val prefs = Prefs(context)
        if (prefs.token.isBlank() || prefs.baseUrl.isBlank()) return
        val svc = Intent(context, InboxService::class.java)
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(svc)
        else context.startService(svc)
    }
}
