package com.linkdrop.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.graphics.Insets
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.WindowInsets
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSaveId: String? = null
    private val outputStreams = ConcurrentHashMap<String, OutputStream>()
    private val pickerRequest = 4201
    private val saveRequest = 4202
    private val serviceUrl by lazy { getString(R.string.service_url).trimEnd('/') }
    private val trustedHost by lazy { Uri.parse(serviceUrl).host }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = true
        webView.settings.javaScriptCanOpenWindowsAutomatically = false
        webView.setOnApplyWindowInsetsListener { view, insets ->
            val systemBars = if (Build.VERSION.SDK_INT >= 30) {
                val bars: Insets = insets.getInsets(WindowInsets.Type.systemBars())
                Rect(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                Rect(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }
        webView.addJavascriptInterface(FileSaveBridge(), "LinkDropAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return true
                if (uri.host == trustedHost) return false
                startActivity(Intent(Intent.ACTION_VIEW, uri))
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                startActivityForResult(intent, pickerRequest)
                return true
            }
        }
        setContentView(webView)
        if (savedInstanceState == null) webView.loadUrl(serviceUrl)
        else webView.restoreState(savedInstanceState)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("The WebView file chooser uses the activity result callback.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == pickerRequest) {
            val uris = if (resultCode == RESULT_OK && data != null) {
                val clip = data.clipData
                if (clip != null) Array(clip.itemCount) { index -> clip.getItemAt(index).uri }
                else data.data?.let { arrayOf(it) }
            } else null
            fileChooserCallback?.onReceiveValue(uris)
            fileChooserCallback = null
            return
        }
        if (requestCode == saveRequest) {
            val id = pendingSaveId ?: return
            pendingSaveId = null
            var success = false
            if (resultCode == RESULT_OK) {
                val uri = data?.data
                if (uri != null) {
                    try {
                        contentResolver.openOutputStream(uri, "w")?.let { outputStreams[id] = it; success = true }
                    } catch (_: Exception) {
                        success = false
                    }
                }
            }
            val safeId = org.json.JSONObject.quote(id)
            val ready = success.toString()
            webView.evaluateJavascript("window.LinkDropCallbacks?.saveReady($safeId, $ready)", null)
        }
    }

    override fun onDestroy() {
        outputStreams.values.forEach { stream -> runCatching { stream.close() } }
        outputStreams.clear()
        webView.removeJavascriptInterface("LinkDropAndroid")
        webView.destroy()
        super.onDestroy()
    }

    inner class FileSaveBridge {
        @JavascriptInterface
        fun beginSave(id: String, name: String, mime: String) {
            if (!id.matches(Regex("[0-9a-fA-F-]{36}"))) return
            runOnUiThread {
                pendingSaveId = id
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mime.takeIf { it.contains('/') && !it.contains(' ') } ?: "application/octet-stream"
                    putExtra(Intent.EXTRA_TITLE, name.take(220).ifBlank { "shared-file" })
                }
                startActivityForResult(intent, saveRequest)
            }
        }

        @JavascriptInterface
        fun writeChunk(id: String, base64: String): Boolean {
            val output = outputStreams[id] ?: return false
            return try {
                output.write(Base64.decode(base64, Base64.DEFAULT))
                true
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun finishSave(id: String): Boolean {
            val output = outputStreams.remove(id) ?: return false
            return try {
                output.flush()
                output.close()
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}
