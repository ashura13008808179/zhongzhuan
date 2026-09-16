package com.relaystation.admin

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class InboxService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "relayadmin:inbox").apply {
            setReferenceCounted(false)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifier.ensureChannels(this)
        startForeground(Notifier.ID_DUTY, Notifier.dutyNotification(this))
        try { wakeLock?.acquire(10 * 60 * 1000L) } catch (_: Exception) { }
        if (!running) {
            running = true
            worker = thread(name = "inbox-poll", isDaemon = true) { loop() }
        } else {
            Notifier.refreshDuty(this)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) { }
        super.onDestroy()
    }

    private fun loop() {
        while (running) {
            try {
                val prefs = Prefs(this)
                if (prefs.baseUrl.isBlank() || prefs.token.isBlank()) {
                    Thread.sleep(2000)
                    continue
                }
                waitOnce()
                try { if (wakeLock?.isHeld != true) wakeLock?.acquire(10 * 60 * 1000L) } catch (_: Exception) { }
            } catch (_: Exception) {
                try { Thread.sleep(2000) } catch (_: InterruptedException) { break }
            }
        }
    }

    private fun waitOnce() {
        val prefs = Prefs(this)
        val base = prefs.baseUrl
        val token = prefs.token
        if (base.isBlank() || token.isBlank()) return
        val after = prefs.lastEventSeq
        val url = URL("$base/api/admin/mobile/inbox/wait?after=$after")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 8000
            readTimeout = 32000
            useCaches = false
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Cache-Control", "no-cache")
        }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.readText().orEmpty()
        conn.disconnect()
        if (code == 404) {
            pollLegacyInbox()
            Thread.sleep(2000)
            return
        }
        if (code != 200) throw RuntimeException("inbox wait $code")
        val json = JSONObject(text)
        val seq = json.optLong("seq", after)
        prefs.lastEventSeq = seq
        val events = json.optJSONArray("events") ?: JSONArray()
        notifyFromEvents(events)
    }

    private fun notifyFromEvents(events: JSONArray) {
        if (events.length() == 0) return
        for (i in 0 until events.length()) {
            val ev = events.optJSONObject(i) ?: continue
            val kind = ev.optString("kind")
            if (kind != "placed" && kind != "paid" && kind != "signup_burst") continue
            if (kind == "signup_burst") {
                val title = ev.optString("title").ifBlank { "注册暴增告警" }
                val body = ev.optString("body").ifBlank { "短时间内有大批账号注册，请打开值班台处理" }
                val tag = "signup:${ev.optString("alertId")}:${ev.opt("seq")}"
                Notifier.notifyOrder(this, title, body, tag)
                continue
            }
            val who = ev.optString("username").ifBlank { "用户" }
            val amount = ev.optDouble("amount", 0.0).toInt()
            val note = ev.optString("payNote", "-").ifBlank { "-" }
            val method = ev.optString("method")
            val methodLabel = when (method) {
                "wechat" -> "微信"
                "alipay" -> "支付宝"
                else -> method.ifBlank { "付款" }
            }
            val title = if (kind == "paid") "待核对充值" else "有人发起充值"
            val body = "$who · ¥$amount · $methodLabel · 备注 $note"
            val tag = "$kind:${ev.optString("orderId")}:${ev.opt("seq")}"
            Notifier.notifyOrder(this, title, body, tag)
        }
    }

    private fun pollLegacyInbox() {
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
        val awaiting = json.optJSONArray("awaiting")
        fun findOrder(src: JSONArray?): JSONObject? {
            if (src == null) return null
            for (i in 0 until src.length()) {
                val o = src.optJSONObject(i) ?: continue
                if (o.optString("id") in fresh) return o
            }
            return null
        }
        val first = findOrder(pending) ?: findOrder(awaiting)
        var body = "有新的充值动态，请打开值班台查看"
        var title = "充值提醒 ${fresh.size} 笔"
        if (first != null) {
            val who = first.optString("username").ifBlank { first.optString("email", "用户") }
            val amount = first.optDouble("amount", 0.0).toInt()
            val note = first.optString("payNote", "-")
            val st = first.optString("status")
            body = "$who · ¥$amount · 备注 $note"
            title = if (st == "pending") "待核对充值 ${fresh.size} 笔" else "有人发起充值 ${fresh.size} 笔"
        }
        Notifier.notifyOrder(this, title, body)
    }
}
