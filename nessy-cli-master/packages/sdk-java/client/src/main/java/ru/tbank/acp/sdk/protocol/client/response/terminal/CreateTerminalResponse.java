package ru.tbank.acp.sdk.protocol.client.response.terminal;

import ru.tbank.acp.sdk.protocol.jsonrpc.Response;

import static ru.tbank.acp.sdk.protocol.client.response.terminal.CreateTerminalResponse.CreateTerminalResponseResult;

public class CreateTerminalResponse extends Response<CreateTerminalResponseResult> {
    public static class CreateTerminalResponseResult {
        private String terminalId;

        // Getters and setters
        public String getTerminalId() {
            return terminalId;
        }

        public void setTerminalId(String terminalId) {
            this.terminalId = terminalId;
        }
    }
}
