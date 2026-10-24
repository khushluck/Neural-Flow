package com.neuralsyntax.neuralflow

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/** Types text into whatever input field currently has focus. Reads nothing else. */
class FlowAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() { instance = this }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
    override fun onUnbind(intent: Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }
    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun insert(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val node = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        if (!node.isEditable) return false

        val hint = node.isShowingHintText
        val cur = if (hint) "" else (node.text?.toString() ?: "")
        var s = if (hint) 0 else node.textSelectionStart
        var e = if (hint) 0 else node.textSelectionEnd
        if (s < 0 || e < 0) { s = cur.length; e = cur.length }
        val a = minOf(s, e).coerceIn(0, cur.length)
        val b = maxOf(s, e).coerceIn(0, cur.length)

        val spacer = if (a > 0 && !cur[a - 1].isWhitespace()) " " else ""
        val ins = spacer + text
        val result = cur.substring(0, a) + ins + cur.substring(b)

        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, result)
        }
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            val pos = a + ins.length
            val sel = Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, pos)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, pos)
            }
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
            return true
        }
        // Fallback for fields that refuse SET_TEXT: paste via clipboard.
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Neural Flow", text))
        return node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
    }

    companion object {
        @Volatile var instance: FlowAccessibilityService? = null
    }
}
