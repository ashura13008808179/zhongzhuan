package com.relaystation.admin

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var prefs: Prefs
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        val uris = when {
            result.resultCode != RESULT_OK -> null
            data?.clipData != null -> Array(data.clipData!!.itemCount) { i ->
                data.clipData!!.getItemAt(i).uri
            }
            data?.data != null -> arrayOf(data.data!!)
            else -> null
        }
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        Notifier.ensureChannels(this)
        requestNotifyPermission()

        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.settings.allowContentAccess = true
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        web.settings.cacheMode = WebSettings.LOAD_DEFAULT
        web.webViewClient = WebViewClient()
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                val intent = try {
                    fileChooserParams?.createIntent()
                } catch (_: Exception) {
                    null
                } ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "image/*"
                }
                return try {
                    fileChooser.launch(intent)
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    filePathCallback?.onReceiveValue(null)
                    Toast.makeText(this@MainActivity, "无法打开相册", Toast.LENGTH_SHORT).show()
                    false
                }
            }
        }
        web.addJavascriptInterface(Bridge(), "AdminBridge")

        if (prefs.baseUrl.isBlank()) askServerUrl()
        else loadApp()
    }

    private fun requestNotifyPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            if (!granted) ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
        }
    }

    private fun askServerUrl() {
        val input = EditText(this)
        input.hint = "例如 https://你的域名 或 http://192.168.1.8:8787"
        input.setText(prefs.baseUrl)
        AlertDialog.Builder(this)
            .setTitle("后端地址")
            .setMessage("填中转站网站地址，不要带末尾斜杠。")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("保存") { _, _ ->
                val url = input.text.toString().trim().trimEnd('/')
                if (url.isBlank()) {
                    Toast.makeText(this, "地址不能为空", Toast.LENGTH_SHORT).show()
                    askServerUrl()
                    return@setPositiveButton
                }
                prefs.baseUrl = url
                loadApp()
            }
            .setNeutralButton("修改稍后") { _, _ -> loadApp() }
            .show()
    }

    private fun loadApp() {
        val base = prefs.baseUrl
        if (base.isBlank()) return
        web.loadUrl("$base/admin-app/")
        startDuty()
    }

    private fun startDuty() {
        if (prefs.token.isBlank() || prefs.baseUrl.isBlank()) return
        val svc = Intent(this, InboxService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc)
        else startService(svc)
    }

    inner class Bridge {
        @JavascriptInterface
        fun onLogin(token: String) {
            prefs.token = token
            runOnUiThread { startDuty() }
        }

        @JavascriptInterface
        fun onLogout() {
            prefs.token = ""
            stopService(Intent(this@MainActivity, InboxService::class.java))
        }

        @JavascriptInterface
        fun editServer() {
            runOnUiThread { askServerUrl() }
        }

        @JavascriptInterface
        fun onNewOrders(payload: String) {
            try {
                val j = JSONObject(payload)
                Notifier.notifyOrder(
                    this@MainActivity,
                    j.optString("title", "待核对充值"),
                    j.optString("body", "请打开值班台确认")
                )
            } catch (_: Exception) { }
        }
    }

    override fun onDestroy() {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        super.onDestroy()
    }

    override fun onBackPressed() {
        if (this::web.isInitialized && web.canGoBack()) web.goBack()
        else super.onBackPressed()
    }
}
