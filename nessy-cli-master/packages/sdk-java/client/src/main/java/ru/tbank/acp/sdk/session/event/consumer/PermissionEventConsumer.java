package ru.tbank.acp.sdk.session.event.consumer;

import ru.tbank.acp.sdk.protocol.agent.request.RequestPermissionRequest;
import ru.tbank.acp.sdk.protocol.client.response.RequestPermissionResponse.RequestPermissionResponseResult;
import ru.tbank.acp.sdk.session.event.consumer.exception.EventConsumeException;
import ru.tbank.acp.sdk.utils.Timeout;

/**
 * Permission Event Consumer Interface
 *
 * This interface defines methods for handling permission-related events received from the AI agent,
 * such as permission requests.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public interface PermissionEventConsumer {
    /**
     * Handles permission requests from the agent
     *
     * @param request Permission request from the agent
     * @return Result of processing the permission request
     * @throws EventConsumeException Thrown when an error occurs during event processing
     */
    RequestPermissionResponseResult onRequestPermissionRequest(RequestPermissionRequest request) throws EventConsumeException;

    /**
     * Gets timeout for permission request processing
     *
     * @param request Permission request
     * @return Timeout for processing the request
     */
    Timeout onRequestPermissionRequestTimeout(RequestPermissionRequest request);
}
