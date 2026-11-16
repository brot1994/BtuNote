package id.bram.btunote

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var web: WebView
    private val io = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var loginDialog: AlertDialog? = null
    @Volatile private var loginRun = 0
    private var pageReady = false
    private var pendingShare: Pair<String, String>? = null

    private val loader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            textZoom = 100
        }
        web.addJavascriptInterface(Bridge(), "BtuNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == "appassets.androidplatform.net") return false
                openExternal(u)
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pendingShare?.let { deliverShare(it) }
                pendingShare = null
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val types = params.acceptTypes.map { it.trim() }.filter { it.isNotEmpty() }
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (types.isNotEmpty() && types.all { it.startsWith("image/") }) "image/*" else "*/*"
                    if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try {
                    startActivityForResult(Intent.createChooser(intent, "Pilih file"), REQ_FILE)
                    true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }
        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
        handleShare(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    private fun handleShare(i: Intent?) {
        if (i?.action != Intent.ACTION_SEND) return
        val text = i.getStringExtra(Intent.EXTRA_TEXT) ?: return
        val title = i.getStringExtra(Intent.EXTRA_SUBJECT) ?: ""
        if (pageReady) deliverShare(title to text) else pendingShare = title to text
    }

    private fun deliverShare(s: Pair<String, String>) {
        js("window.BtuApp && BtuApp.onShare(${JSONObject.quote(s.first)}, ${JSONObject.quote(s.second)})")
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        if (pageReady) js("window.BtuApp && BtuApp.onResume()")
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_FILE) {
            val cb = fileCallback
            fileCallback = null
            if (cb == null) return
            if (resultCode != RESULT_OK || data == null) { cb.onReceiveValue(null); return }
            val uris = mutableListOf<Uri>()
            data.clipData?.let { c -> for (k in 0 until c.itemCount) uris.add(c.getItemAt(k).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
            cb.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    private fun js(code: String) = main.post { web.evaluateJavascript(code, null) }

    private fun openExternal(u: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) { }
    }

    private fun toast(msg: String) = main.post { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }

    // ---------------- login (device code) ----------------
    private fun startLogin() {
        val run = ++loginRun
        io.execute {
            val dc = try { Auth.requestDeviceCode() } catch (e: Exception) {
                js("BtuApp.onNativeLogin(false, ${JSONObject.quote("Login gagal: ${e.message}")})")
                return@execute
            }
            main.post { showLoginDialog(dc, run) }
            val deadline = System.currentTimeMillis() + dc.expiresIn * 1000L
            var wait = dc.interval.coerceAtLeast(3) * 1000L
            while (run == loginRun && System.currentTimeMillis() < deadline) {
                Thread.sleep(wait)
                if (run != loginRun) return@execute
                val r = Auth.poll(this, dc) ?: continue
                main.post { loginDialog?.dismiss(); loginDialog = null }
                loginRun++
                if (r.isEmpty()) js("BtuApp.onNativeLogin(true)")
                else js("BtuApp.onNativeLogin(false, ${JSONObject.quote(r)})")
                return@execute
            }
            if (run == loginRun) {
                main.post { loginDialog?.dismiss(); loginDialog = null }
                js("BtuApp.onNativeLogin(false, ${JSONObject.quote("Waktu login habis, coba lagi.")})")
            }
        }
    }

    private fun showLoginDialog(dc: Auth.DeviceCode, run: Int) {
        if (run != loginRun || isFinishing) return
        val pad = (20 * resources.displayMetrics.density).toInt()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
        }
        box.addView(TextView(this).apply {
            text = "1. Ketuk \"Salin kode & buka\" — kode disalin dan halaman Microsoft terbuka.\n" +
                "2. Tempel kode, lalu login dengan akun OneDrive HNK.\n" +
                "3. Kembali ke BtuNote, login selesai otomatis."
            textSize = 15f
        })
        box.addView(TextView(this).apply {
            text = dc.userCode
            textSize = 30f
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.12f
            gravity = Gravity.CENTER
            setTextIsSelectable(true)
            setPadding(0, pad, 0, pad / 2)
        })
        val d = AlertDialog.Builder(this)
            .setTitle("Login OneDrive")
            .setView(box)
            .setPositiveButton("Salin kode & buka", null)
            .setNegativeButton("Batal") { _, _ -> loginRun++ }
            .setCancelable(false)
            .create()
        d.setOnShowListener {
            d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("kode", dc.userCode))
                openExternal(Uri.parse(dc.uri))
            }
        }
        loginDialog = d
        d.show()
    }

    // ---------------- simpan file ke Download ----------------
    private fun saveToDownloads(name: String, mime: String, b64: String, open: Boolean) {
        io.execute {
            try {
                val bytes = Base64.decode(b64, Base64.DEFAULT)
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("Tidak bisa membuat file")
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
                if (open) {
                    main.post {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                        } catch (e: ActivityNotFoundException) {
                            Toast.makeText(this, "Disimpan di Download: $name", Toast.LENGTH_LONG).show()
                        }
                    }
                } else toast("Disimpan di folder Download: $name")
            } catch (e: Exception) {
                toast("Gagal menyimpan: ${e.message}")
            }
        }
    }

    // ---------------- jembatan untuk JavaScript ----------------
    inner class Bridge {
        @JavascriptInterface fun isLoggedIn(): String = Auth.isLoggedIn(this@MainActivity).toString()

        @JavascriptInterface fun login() { main.post { startLogin() } }

        @JavascriptInterface fun logout() { loginRun++; Auth.logout(this@MainActivity) }

        @JavascriptInterface fun token(id: Int) {
            io.execute {
                try {
                    val t = Auth.token(this@MainActivity)
                    js("__btuNativeCb($id, ${JSONObject.quote(t)}, null)")
                } catch (e: Auth.LoginRequired) {
                    js("__btuNativeCb($id, null, 'LOGIN')")
                } catch (e: Exception) {
                    js("__btuNativeCb($id, null, ${JSONObject.quote(e.message ?: "Gagal")})")
                }
            }
        }

        @JavascriptInterface fun saveFile(name: String, mime: String, b64: String, open: String) {
            saveToDownloads(name, mime, b64, open == "true")
        }

        @JavascriptInterface fun setDark(dark: String) {
            main.post {
                val d = dark == "true"
                val bg = if (d) Color.parseColor("#202124") else Color.WHITE
                window.statusBarColor = bg
                window.navigationBarColor = bg
                web.setBackgroundColor(bg)
                var f = window.decorView.systemUiVisibility
                @Suppress("DEPRECATION")
                f = if (d) f and (View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR).inv()
                else f or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = f
            }
        }
    }

    companion object { private const val REQ_FILE = 41 }
}
