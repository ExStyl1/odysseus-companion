package org.nessy.intellij.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@Service(Service.Level.APP)
@State(name = "nessySettings", storages = [Storage("nessy.xml")])
class NessySettingsState : PersistentStateComponent<NessySettingsState.State> {
  data class State(
    var nodePath: String = "",
    var lastNotifiedPluginVersion: String = "",
  )

  private var state = State()

  override fun getState(): State = state

  override fun loadState(state: State) {
    this.state = state
  }

  var nodePath: String
    get() = state.nodePath
    set(value) {
      state.nodePath = value
    }

  var lastNotifiedPluginVersion: String
    get() = state.lastNotifiedPluginVersion
    set(value) {
      state.lastNotifiedPluginVersion = value
    }


  companion object {
    fun getInstance(): NessySettingsState {
      return ApplicationManager.getApplication().getService(NessySettingsState::class.java)
    }
  }
}
