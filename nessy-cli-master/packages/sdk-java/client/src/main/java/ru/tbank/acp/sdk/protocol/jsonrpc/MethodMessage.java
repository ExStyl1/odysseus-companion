package ru.tbank.acp.sdk.protocol.jsonrpc;

import java.util.UUID;

import ru.tbank.acp.sdk.protocol.agent.notification.SessionNotification;
import ru.tbank.acp.sdk.protocol.agent.request.AuthenticateRequest;
import ru.tbank.acp.sdk.protocol.agent.request.ReadTextFileRequest;
import ru.tbank.acp.sdk.protocol.agent.request.RequestPermissionRequest;
import ru.tbank.acp.sdk.protocol.agent.request.WriteTextFileRequest;
import ru.tbank.acp.sdk.protocol.agent.request.terminal.CreateTerminalRequest;
import ru.tbank.acp.sdk.protocol.agent.request.terminal.KillTerminalCommandRequest;
import ru.tbank.acp.sdk.protocol.agent.request.terminal.ReleaseTerminalRequest;
import ru.tbank.acp.sdk.protocol.agent.request.terminal.TerminalOutputRequest;
import ru.tbank.acp.sdk.protocol.agent.request.terminal.WaitForTerminalExitRequest;
import ru.tbank.acp.sdk.protocol.client.request.InitializeRequest;
import ru.tbank.acp.sdk.protocol.client.request.LoadSessionRequest;
import ru.tbank.acp.sdk.protocol.client.request.NewSessionRequest;
import ru.tbank.acp.sdk.protocol.client.request.PromptRequest;
import ru.tbank.acp.sdk.protocol.client.request.SetSessionModeRequest;
import com.alibaba.fastjson2.annotation.JSONType;

import org.apache.commons.lang3.Validate;

@JSONType(typeKey = "method", seeAlso = {
        AuthenticateRequest.class,
        ReadTextFileRequest.class,
        RequestPermissionRequest.class,
        WriteTextFileRequest.class,
        CreateTerminalRequest.class,
        KillTerminalCommandRequest.class,
        ReleaseTerminalRequest.class,
        TerminalOutputRequest.class,
        WaitForTerminalExitRequest.class,
        InitializeRequest.class,
        LoadSessionRequest.class,
        NewSessionRequest.class,
        PromptRequest.class,
        SetSessionModeRequest.class,
        SessionNotification.class,
})
public class MethodMessage<P> extends Message {
    protected String method;
    protected P params;

    public String getMethod() {
        return method;
    }

    public void setMethod(String method) {
        this.method = method;
    }

    public P getParams() {
        return params;
    }

    public void setParams(P params) {
        this.params = params;
    }

    public MethodMessage() {
        this.id = UUID.randomUUID().toString();
    }

    public MethodMessage(String method, P params) {
        this();
        Validate.notEmpty(method, "method can not be empty");
        this.method = method;
        Validate.notNull(params, "params can not be null");
        this.params = params;
    }
}
