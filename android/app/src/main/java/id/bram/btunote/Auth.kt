package id.bram.btunote

import android.content.Context
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Login Microsoft dengan "device code" (sama seperti Backup Keluarga).
 * Memakai pendaftaran aplikasi "Backup Keluarga" di tenant HNK.
 */
object Auth {
    const val CLIENT_ID = "5b3f10d5-c71d-4e1a-9905-dec339836576"
    const val TENANT_ID = "e8d4d325-ed67-4992-9ade-8b6a0ba06ba4"
    const val SCOPES = "Files.ReadWrite User.Read offline_access"
    const val VERIFY_URL = "https://microsoft.com/devicelogin"
    private const val BASE = "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0"
    private val lock = Any()

    class LoginRequired(msg: String) : IOException(msg)

    data class DeviceCode(val deviceCode: String, val userCode: String, val uri: String, val expiresIn: Int, val interval: Int)

    private fun prefs(c: Context) = c.getSharedPreferences("auth", Context.MODE_PRIVATE)

    private fun post(url: String, params: Map<String, String>): Pair<Int, JSONObject> {
        val body = params.entries.joinToString("&") {
            URLEncoder.encode(it.key, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
        }
        val con = URL(url).openConnection() as HttpURLConnection
        con.requestMethod = "POST"
        con.connectTimeout = 20000
        con.readTimeout = 30000
        con.doOutput = true
        con.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
        con.outputStream.use { it.write(body.toByteArray()) }
        val code = con.responseCode
        val text = (if (code in 200..299) con.inputStream else con.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        con.disconnect()
        val json = try { JSONObject(text) } catch (e: Exception) {
            JSONObject().put("error", "bad_response").put("error_description", text.take(200))
        }
        return code to json
    }

    fun isLoggedIn(c: Context) = prefs(c).getString("rt", null) != null

    fun requestDeviceCode(): DeviceCode {
        val (code, j) = post("$BASE/devicecode", mapOf("client_id" to CLIENT_ID, "scope" to SCOPES))
        if (code != 200) throw IOException(j.optString("error_description", "Gagal meminta kode ($code)").lineSequence().first())
        return DeviceCode(
            j.getString("device_code"), j.getString("user_code"),
            j.optString("verification_uri", VERIFY_URL), j.optInt("expires_in", 900), j.optInt("interval", 5),
        )
    }

    /** null = masih menunggu; "" = sukses; teks lain = gagal */
    fun poll(c: Context, dc: DeviceCode): String? {
        val (code, j) = try {
            post("$BASE/token", mapOf(
                "grant_type" to "urn:ietf:params:oauth:grant-type:device_code",
                "client_id" to CLIENT_ID, "device_code" to dc.deviceCode,
            ))
        } catch (e: IOException) { return null }
        if (code == 200) { save(c, j); return "" }
        return when (j.optString("error")) {
            "authorization_pending", "slow_down" -> null
            "authorization_declined" -> "Persetujuan ditolak."
            "expired_token" -> "Kode sudah kedaluwarsa, coba lagi."
            else -> j.optString("error_description", "Login gagal ($code)").lineSequence().first()
        }
    }

    private fun save(c: Context, j: JSONObject) {
        val p = prefs(c)
        p.edit()
            .putString("at", j.getString("access_token"))
            .putLong("exp", System.currentTimeMillis() + (j.optLong("expires_in", 3600L) - 120) * 1000)
            .putString("rt", j.optString("refresh_token").ifEmpty { p.getString("rt", null) })
            .putBoolean("reauth", false)
            .apply()
    }

    /** Token akses yang masih berlaku; diperbarui otomatis. */
    fun token(c: Context): String = synchronized(lock) {
        val p = prefs(c)
        val at = p.getString("at", null)
        if (at != null && System.currentTimeMillis() < p.getLong("exp", 0)) return at
        val rt = p.getString("rt", null) ?: throw LoginRequired("Belum login")
        if (p.getBoolean("reauth", false)) throw LoginRequired("Perlu login ulang")
        val (code, j) = post("$BASE/token", mapOf(
            "grant_type" to "refresh_token", "client_id" to CLIENT_ID, "refresh_token" to rt, "scope" to SCOPES,
        ))
        if (code == 200) { save(c, j); return j.getString("access_token") }
        val err = j.optString("error")
        if (err in setOf("invalid_grant", "interaction_required", "invalid_client", "unauthorized_client")) {
            p.edit().putBoolean("reauth", true).apply()
            throw LoginRequired("Perlu login ulang")
        }
        throw IOException("Gagal memperbarui login ($code $err)")
    }

    fun logout(c: Context) { prefs(c).edit().clear().apply() }
}
