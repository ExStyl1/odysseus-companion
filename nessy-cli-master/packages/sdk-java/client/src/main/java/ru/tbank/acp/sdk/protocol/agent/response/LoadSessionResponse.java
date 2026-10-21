package ru.tbank.acp.sdk.protocol.agent.response;

import ru.tbank.acp.sdk.protocol.domain.session.SessionModeState;
import ru.tbank.acp.sdk.protocol.jsonrpc.Response;

import static ru.tbank.acp.sdk.protocol.agent.response.LoadSessionResponse.LoadSessionResponseResult;

public class LoadSessionResponse extends Response<LoadSessionResponseResult> {
    public static class LoadSessionResponseResult {
        private SessionModeState modes;

        // Getters and setters
        public SessionModeState getModes() {
            return modes;
        }

        public void setModes(SessionModeState modes) {
            this.modes = modes;
        }
    }
}
