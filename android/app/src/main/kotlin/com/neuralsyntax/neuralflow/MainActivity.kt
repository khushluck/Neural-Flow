package com.neuralsyntax.neuralflow

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

private const val BG = 0xFF131421.toInt()
private const val TEXT = 0xFFD9DEE8.toInt()
private const val MUTED = 0xFFA9B4C7.toInt()
private const val BORDER = 0xFF4E5C72.toInt()
private const val TEAL = 0xFF289B9E.toInt()

class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var keyBox: EditText
    private lateinit var langBox: EditText

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_LONG).show()
    private fun micOk() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun label(t: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = t; textSize = size; setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(6), 0, dp(6))
    }

    private fun field(hintText: String, value: String, secret: Boolean) = EditText(this).apply {
        setText(value); hint = hintText; setTextColor(TEXT); setHintTextColor(MUTED); textSize = 15f
        inputType = InputType.TYPE_CLASS_TEXT or (if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else 0)
        setPadding(dp(14), dp(12), dp(14), dp(12))
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat(); setStroke(dp(1), BORDER); setColor(0xFF1B1D30.toInt())
        }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = dp(8) }
    }

    private fun button(t: String, filled: Boolean, onClick: () -> Unit) = Button(this).apply {
        text = t; isAllCaps = false; setTextColor(Color.WHITE); textSize = 15f
        background = GradientDrawable().apply {
            cornerRadius = dp(14).toFloat()
            if (filled) setColor(TEAL) else { setColor(Color.TRANSPARENT); setStroke(dp(1), BORDER) }
        }
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(10) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = BG
        window.navigationBarColor = BG
        val pad = dp(20)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad * 2, pad, pad) }

        col.addView(label(getString(R.string.app_name), 28f, Color.WHITE, true))
        col.addView(label("A floating mic button for any app. Tap it, speak, tap again and your words are typed where your cursor is.", 14f, MUTED))

        status = label("", 15f, TEXT)
        col.addView(status)

        col.addView(label("Groq API key (free at console.groq.com/keys)", 13f, MUTED))
        keyBox = field("gsk_...", Prefs.key(this), true)
        col.addView(keyBox)
        langBox = field("Language code, e.g. en or hi (blank = auto-detect)", Prefs.lang(this), false)
        col.addView(langBox)
        col.addView(button("Save settings", true) {
            Prefs.save(this, keyBox.text.toString(), langBox.text.toString()); toast("Saved"); refresh()
        })
        col.addView(button("Test API key", false) {
            val k = keyBox.text.toString().trim()
            if (k.isEmpty()) { toast("Enter your key first"); return@button }
            Thread {
                val r = try { Groq.testKey(k); "Key works" } catch (e: Exception) { e.message ?: "Test failed" }
                runOnUiThread { toast(r) }
            }.start()
        })

        col.addView(label("Setup (do these once)", 16f, Color.WHITE, true))
        col.addView(button("1. Allow display over other apps", false) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        })
        col.addView(button("2. Enable accessibility service", false) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })
        col.addView(label("If the accessibility switch is greyed out (Android 13+): Settings > Apps > Neural Flow > three dots > Allow restricted settings, then try again.", 12f, MUTED))
        col.addView(button("3. Allow microphone & notifications", false) {
            val perms = if (Build.VERSION.SDK_INT >= 33)
                arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
            else arrayOf(Manifest.permission.RECORD_AUDIO)
            requestPermissions(perms, 1)
        })

        col.addView(button("Start floating button", true) {
            Prefs.save(this, keyBox.text.toString(), langBox.text.toString())
            when {
                Prefs.key(this).isEmpty() -> toast("Add your Groq API key first")
                !Settings.canDrawOverlays(this) -> toast("Do step 1 first")
                !micOk() -> toast("Do step 3 first")
                else -> startForegroundService(Intent(this, FlowService::class.java))
            }
            status.postDelayed({ refresh() }, 600)
        })
        col.addView(button("Stop floating button", false) {
            stopService(Intent(this, FlowService::class.java))
            status.postDelayed({ refresh() }, 600)
        })

        setContentView(ScrollView(this).apply { setBackgroundColor(BG); addView(col) })
    }

    override fun onResume() { super.onResume(); refresh() }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
    }

    private fun mark(ok: Boolean) = if (ok) "\u2713" else "\u2717"

    private fun refresh() {
        status.text = listOf(
            mark(Prefs.key(this).isNotEmpty()) + "  API key saved",
            mark(Settings.canDrawOverlays(this)) + "  Display over other apps",
            mark(FlowAccessibilityService.instance != null) + "  Accessibility service on",
            mark(micOk()) + "  Microphone",
            mark(FlowService.running) + "  Floating button running"
        ).joinToString("\n")
    }
}
