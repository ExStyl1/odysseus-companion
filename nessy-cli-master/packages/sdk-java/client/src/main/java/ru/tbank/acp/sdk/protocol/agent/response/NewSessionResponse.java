package ru.tbank.acp.sdk.protocol.agent.response;

import ru.tbank.acp.sdk.protocol.domain.session.SessionModeState;
import ru.tbank.acp.sdk.protocol.jsonrpc.Response;

import static ru.tbank.acp.sdk.protocol.agent.response.NewSessionResponse.NewSessionResponseResult;

public class NewSessionResponse extends Response<NewSessionResponseResult> {
    public static class NewSessionResponseResult {
        private String sessionId;
        private SessionModeState modes;

        // Getters and setters
        public String getSessionId() {
            return sessionId;
        }

        public void setSessionId(String sessionId) {
            this.sessionId = sessionId;
        }

        public SessionModeState getModes() {
            return modes;
        }

        public void setModes(SessionModeState modes) {
            this.modes = modes;
        }
    }
}
