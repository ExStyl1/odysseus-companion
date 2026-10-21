package org.nessy.intellij.acp

object AcpProtocol {
  const val JSONRPC_VERSION = "2.0"

  object AgentMethods {
    const val INITIALIZE = "initialize"
    const val AUTHENTICATE = "authenticate"
    const val SESSION_NEW = "session/new"
    const val SESSION_PROMPT = "session/prompt"
    const val SESSION_LIST = "session/list"
    const val SESSION_LOAD = "session/load"
    const val SESSION_CANCEL = "session/cancel"
    const val SESSION_SET_MODE = "session/set_mode"
    // Extended methods (Nessy-specific)
    const val SESSION_DELETE = "deleteSession"
    const val SESSION_RENAME = "renameSession"
    const val SESSION_REWIND = "rewindSession"
    const val SESSION_RESTORE_HISTORY = "restoreSessionHistory"
    const val GET_ACCOUNT_INFO = "getAccountInfo"
    const val SESSION_SET_MODEL = "session/set_model"
  }

  object ClientMethods {
    const val SESSION_UPDATE = "session/update"
    const val AUTHENTICATE_UPDATE = "authenticate/update"
    const val SESSION_REQUEST_PERMISSION = "session/request_permission"
    const val SESSION_ASK_USER_QUESTION = "session/ask_user_question"
    // [nessy-fork] acp-elicitation-ask-user-question
    const val SESSION_REQUEST_ELICITATION = "elicitation/create"
    const val FS_READ_TEXT_FILE = "fs/read_text_file"
    const val FS_WRITE_TEXT_FILE = "fs/write_text_file"
  }
}
