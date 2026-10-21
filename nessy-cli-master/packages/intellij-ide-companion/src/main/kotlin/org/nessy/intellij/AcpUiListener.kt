package org.nessy.intellij

import com.google.gson.JsonObject

interface AcpUiListener {
  fun onAssistantChunk(text: String, isThought: Boolean, sessionId: String? = null)
  fun onInitialized(info: JsonObject)
  fun onAuthUpdate(uri: String)
  fun onError(message: String)
  fun onStatus(message: String)
  fun onSessionUpdate(update: JsonObject)
  fun onPermissionRequest(request: JsonObject)
  fun onPermissionResolved(optionId: String)
  fun onAskUserQuestion(request: JsonObject)
}
