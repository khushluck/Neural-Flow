package com.neuralsyntax.neuralflow

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.Icon
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.Toast
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.max

enum class BubbleState { IDLE, RECORDING, PROCESSING }

/** Draggable floating mic button. Teal = ready, red = recording (tap to stop), indigo = working. */
class Bubble(ctx: Context) : View(ctx) {
    var state: BubbleState = BubbleState.IDLE
        set(v) { field = v; invalidate() }
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onDraw(c: Canvas) {
        val w = width.toFloat()
        val r = w / 2f
        p.style = Paint.Style.FILL
        p.shader = null
        when (state) {
            BubbleState.IDLE -> p.shader = LinearGradient(
                0f, 0f, w, w,
                intArrayOf(0xFF289B9E.toInt(), 0xFF2F658E.toInt(), 0xFF51559E.toInt(), 0xFF5A3697.toInt()),
                null, Shader.TileMode.CLAMP
            )
            BubbleState.RECORDING -> p.color = 0xFFD64550.toInt()
            BubbleState.PROCESSING -> p.color = 0xFF51559E.toInt()
        }
        c.drawCircle(r, r, r - 2f, p)
        p.shader = null
        p.color = Color.WHITE
        val s = w / 56f
        if (state == BubbleState.RECORDING) {
            c.drawRoundRect(RectF(19f * s, 19f * s, 37f * s, 37f * s), 3f * s, 3f * s, p)
            return
        }
        c.drawRoundRect(RectF(22f * s, 12f * s, 34f * s, 30f * s), 6f * s, 6f * s, p)
        p.style = Paint.Style.STROKE
        p.strokeWidth = 2.5f * s
        p.strokeCap = Paint.Cap.ROUND
        c.drawArc(RectF(17f * s, 19f * s, 39f * s, 38f * s), 0f, 180f, false, p)
        c.drawLine(28f * s, 38f * s, 28f * s, 44f * s, p)
    }
}

class FlowService : Service() {

    companion object {
        const val ACTION_STOP = "com.neuralsyntax.neuralflow.STOP"
        private const val CHANNEL = "flow"
        @Volatile var running = false
    }

    private lateinit var wm: WindowManager
    private lateinit var lp: WindowManager.LayoutParams
    private var bubble: Bubble? = null
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val pcm = ByteArrayOutputStream()
    private var recThread: Thread? = null
    @Volatile private var recording = false
    private val autoStop = Runnable { if (recording) stopAndTranscribe() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }
        goForeground()
        if (bubble == null) addBubble()
        running = true
        return START_NOT_STICKY
    }

    private fun goForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Floating button", NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(
            this, 0, Intent(this, FlowService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val action = Notification.Action.Builder(
            Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel), "Stop", stop
        ).build()
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Neural Flow is ready")
            .setContentText("Tap the floating mic to dictate")
            .setOngoing(true)
            .addAction(action)
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        else startForeground(1, n)
    }

    private fun addBubble() {
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val size = (56 * resources.displayMetrics.density).toInt()
        lp = WindowManager.LayoutParams(
            size, size, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // NOT_FOCUSABLE keeps keyboard focus in the app you are typing in
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = 24
        lp.y = (resources.displayMetrics.heightPixels * 0.4).toInt()

        val b = Bubble(this)
        b.contentDescription = "Neural Flow dictation button"
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        var sx = 0; var sy = 0; var tx = 0f; var ty = 0f; var moved = false
        b.setOnTouchListener { v, ev ->
            when (ev.action) {
                MotionEvent.ACTION_DOWN -> { sx = lp.x; sy = lp.y; tx = ev.rawX; ty = ev.rawY; moved = false; true }
                MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - tx
                    val dy = ev.rawY - ty
                    if (abs(dx) > slop || abs(dy) > slop) moved = true
                    if (moved) { lp.x = (sx + dx).toInt(); lp.y = (sy + dy).toInt(); wm.updateViewLayout(v, lp) }
                    true
                }
                MotionEvent.ACTION_UP -> { if (!moved) onTap(); true }
                else -> false
            }
        }
        wm.addView(b, lp)
        bubble = b
    }

    private fun onTap() {
        when (bubble?.state) {
            BubbleState.IDLE -> startRecording()
            BubbleState.RECORDING -> stopAndTranscribe()
            else -> {}
        }
    }

    private fun setState(s: BubbleState) { bubble?.state = s }
    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    private fun startRecording() {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            toast("Microphone permission is missing"); return
        }
        if (Prefs.key(this).isEmpty()) { toast("Add your Groq API key in the app first"); return }
        if (FlowAccessibilityService.instance == null) {
            toast("Turn on the Neural Flow accessibility service first"); return
        }
        val bufSize = max(AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), 16000)
        val rec: AudioRecord? = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize)
        } catch (e: Exception) { null }
        if (rec == null || rec.state != AudioRecord.STATE_INITIALIZED) {
            rec?.release(); toast("Couldn't open the microphone"); return
        }
        try { rec.startRecording() } catch (e: Exception) {
            rec.release(); toast("Couldn't start recording"); return
        }
        synchronized(pcm) { pcm.reset() }
        recording = true
        setState(BubbleState.RECORDING)
        recThread = Thread {
            val buf = ByteArray(4096)
            while (recording) {
                val n = rec.read(buf, 0, buf.size)
                if (n > 0) {
                    synchronized(pcm) { pcm.write(buf, 0, n) }
                } else if (n < 0) {
                    break
                }
            }
            try { rec.stop() } catch (e: Exception) { }
            rec.release()
        }.also { it.start() }
        main.postDelayed(autoStop, 120_000)
    }

    private fun stopAndTranscribe() {
        recording = false
        main.removeCallbacks(autoStop)
        setState(BubbleState.PROCESSING)
        val t = recThread
        io.execute {
            try { t?.join(2000) } catch (e: InterruptedException) { }
            val data = synchronized(pcm) { pcm.toByteArray() }
            if (data.size < 12800) { main.post { setState(BubbleState.IDLE) }; return@execute } // < 0.4 s: accidental tap
            try {
                val key = Prefs.key(this)
                var text = Groq.transcribe(key, data, Prefs.lang(this))
                if (text.isBlank()) {
                    main.post { toast("Didn't catch that"); setState(BubbleState.IDLE) }
                    return@execute
                }
                if (BuildConfig.CLEANUP) text = try { Groq.cleanup(key, text) } catch (e: Exception) { text }
                val finalText = text
                main.post { deliver(finalText) }
            } catch (e: Exception) {
                main.post { toast(e.message ?: "Something went wrong"); setState(BubbleState.IDLE) }
            }
        }
    }

    private fun deliver(text: String) {
        val ok = FlowAccessibilityService.instance?.insert(text) == true
        if (!ok) {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("Neural Flow", text))
            toast("Couldn't type here. Text copied, paste it manually.")
        }
        setState(BubbleState.IDLE)
    }

    override fun onDestroy() {
        recording = false
        main.removeCallbacks(autoStop)
        bubble?.let { try { wm.removeView(it) } catch (e: Exception) { } }
        bubble = null
        io.shutdown()
        running = false
        super.onDestroy()
    }
}
