package ru.tbank.acp.sdk.session.event.consumer;

import ru.tbank.acp.sdk.protocol.domain.session.update.AgentMessageChunkSessionUpdate;
import ru.tbank.acp.sdk.protocol.domain.session.update.AvailableCommandsUpdateSessionUpdate;
import ru.tbank.acp.sdk.protocol.domain.session.update.CurrentModeUpdateSessionUpdate;
import ru.tbank.acp.sdk.protocol.domain.session.update.PlanSessionUpdate;
import ru.tbank.acp.sdk.protocol.domain.session.update.ToolCallSessionUpdate;
import ru.tbank.acp.sdk.protocol.domain.session.update.ToolCallUpdateSessionUpdate;
import ru.tbank.acp.sdk.utils.Timeout;

/**
 * Simple Content Event Consumer Implementation
 *
 * This class provides a simple implementation of the ContentEventConsumer interface
 * that performs minimal processing for content-related events, primarily serving as a base
 * implementation that can be extended or used as-is for basic functionality.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class ContentEventSimpleConsumer implements ContentEventConsumer {
    @Override
    public void onAgentMessageChunkSessionUpdate(AgentMessageChunkSessionUpdate sessionUpdate) {
        // Simple implementation - does nothing
    }

    @Override
    public void onAvailableCommandsUpdateSessionUpdate(AvailableCommandsUpdateSessionUpdate sessionUpdate) {
        // Simple implementation - does nothing
    }

    @Override
    public void onCurrentModeUpdateSessionUpdate(CurrentModeUpdateSessionUpdate sessionUpdate) {
        // Simple implementation - does nothing
    }

    @Override
    public void onPlanSessionUpdate(PlanSessionUpdate sessionUpdate) {
        // Simple implementation - does nothing
    }

    @Override
    public void onToolCallUpdateSessionUpdate(ToolCallUpdateSessionUpdate sessionUpdate) {
        // Simple implementation - does nothing
    }

    @Override
    public void onToolCallSessionUpdate(ToolCallSessionUpdate sessionUpdate) {
        // Simple implementation - does nothing
    }

    @Override
    public Timeout onAgentMessageChunkSessionUpdateTimeout(AgentMessageChunkSessionUpdate sessionUpdate) {
        return defaultTimeout;
    }

    @Override
    public Timeout onAvailableCommandsUpdateSessionUpdateTimeout(AvailableCommandsUpdateSessionUpdate sessionUpdate) {
        return defaultTimeout;
    }

    @Override
    public Timeout onCurrentModeUpdateSessionUpdateTimeout(CurrentModeUpdateSessionUpdate sessionUpdate) {
        return defaultTimeout;
    }

    @Override
    public Timeout onPlanSessionUpdateTimeout(PlanSessionUpdate sessionUpdate) {
        return defaultTimeout;
    }

    @Override
    public Timeout onToolCallUpdateSessionUpdateTimeout(ToolCallUpdateSessionUpdate sessionUpdate) {
        return defaultTimeout;
    }

    @Override
    public Timeout onToolCallSessionUpdateTimeout(ToolCallSessionUpdate sessionUpdate) {
        return defaultTimeout;
    }

    /** Default timeout for event processing is 60 seconds */
    Timeout defaultTimeout = Timeout.TIMEOUT_60_SECONDS;
}
