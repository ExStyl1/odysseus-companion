package ru.tbank.acp.sdk.protocol.client.response;

import ru.tbank.acp.sdk.protocol.jsonrpc.Error;
import ru.tbank.acp.sdk.protocol.jsonrpc.Response;

import static ru.tbank.acp.sdk.protocol.client.response.ReadTextFileResponse.ReadTextFileResponseResult;

public class ReadTextFileResponse extends Response<ReadTextFileResponseResult> {
    public ReadTextFileResponse() {
    }

    public ReadTextFileResponse(Object id, ReadTextFileResponseResult result) {
        super(id, result);
    }

    public ReadTextFileResponse(Object id, Error error) {
        super(id, error);
    }

    public static class ReadTextFileResponseResult {
        private String content;

        // Getters and setters
        public String getContent() {
            return content;
        }

        public ReadTextFileResponseResult setContent(String content) {
            this.content = content;
            return this;
        }
    }
}
