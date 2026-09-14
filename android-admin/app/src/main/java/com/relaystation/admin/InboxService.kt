package com.relaystation.admin

import android.app.Service
import android.content.Intent
import android.os.IBinder
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class InboxService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifier.ensureChannels(this)
        startForeground(Notifier.ID_DUTY, Notifier.dutyNotification(this))
        if (!running) {
            running = true
            worker = thread(name = "inbox-poll", isDaemon = true) { loop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun loop() {
        while (running) {
            try { pollOnce() } catch (_: Exception) { }
            try { Thread.sleep(20_000) } catch (_: InterruptedException) { break }
        }
    }

    private fun pollOnce() {
        val prefs = Prefs(this)
        val base = prefs.baseUrl
        val token = prefs.token
        if (base.isBlank() || token.isBlank()) return
        val url = URL("$base/api/admin/mobile/inbox")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 12000
            readTimeout = 12000
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
        }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.readText().orEmpty()
        conn.disconnect()
        if (code != 200) return
        val json = JSONObject(text)
        val arr = json.optJSONArray("notifyIds") ?: return
        val ids = mutableSetOf<String>()
        for (i in 0 until arr.length()) ids.add(arr.optString(i))
        if (!prefs.seeded) {
            prefs.lastNotifyIds = ids
            prefs.seeded = true
            return
        }
        val fresh = ids.filter { it !in prefs.lastNotifyIds }
        prefs.lastNotifyIds = ids
        if (fresh.isEmpty()) return
        val pending = json.optJSONArray("pending")
        var body = "请打开值班台确认到账并发卡"
        if (pending != null && pending.length() > 0) {
            val first = pending.optJSONObject(0)
            if (first != null) {
                val who = first.optString("username").ifBlank { first.optString("email", "用户") }
                val amount = first.optDouble("amount", 0.0).toInt()
                val note = first.optString("payNote", "-")
                body = "$who ¥$amount · 备注 $note"
            }
        }
        Notifier.notifyOrder(this, "待核对充值 ${fresh.size} 笔", body)
    }
}
