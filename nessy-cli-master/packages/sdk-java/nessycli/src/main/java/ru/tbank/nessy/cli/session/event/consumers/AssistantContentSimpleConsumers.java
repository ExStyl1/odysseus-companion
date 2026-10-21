package ru.tbank.nessy.cli.session.event.consumers;

import ru.tbank.nessy.cli.protocol.data.AssistantUsage;
import ru.tbank.nessy.cli.protocol.data.AssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.TextAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ThinkingAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ToolResultAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ToolUseAssistantContent;
import ru.tbank.nessy.cli.protocol.data.behavior.Allow;
import ru.tbank.nessy.cli.protocol.data.behavior.Behavior;
import ru.tbank.nessy.cli.protocol.data.behavior.Behavior.Operation;
import ru.tbank.nessy.cli.protocol.data.behavior.Deny;
import ru.tbank.nessy.cli.protocol.message.control.payload.CLIControlPermissionRequest;
import ru.tbank.nessy.cli.protocol.message.control.payload.ControlRequestPayload;
import ru.tbank.nessy.cli.protocol.message.control.payload.ControlResponsePayload;
import ru.tbank.nessy.cli.session.Session;
import ru.tbank.nessy.cli.utils.Timeout;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Simple implementation of AssistantContentConsumers that provides empty implementations for all methods.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class AssistantContentSimpleConsumers implements AssistantContentConsumers {
    /**
     * {@inheritDoc}
     */
    @Override
    public void onText(Session session, TextAssistantContent textAssistantContent) {
        log.debug("Received textAssistantContent {}", textAssistantContent.getText());
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onThinking(Session session, ThinkingAssistantContent thinkingAssistantContent) {
        log.debug("Received thinkingAssistantContent {}", thinkingAssistantContent.getThinking());
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onToolUse(Session session, ToolUseAssistantContent toolUseAssistantContent) {
        log.debug("Received toolUseAssistantContent {}", toolUseAssistantContent.getInput());
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onToolResult(Session session, ToolResultAssistantContent toolResultAssistantContent) {
        if (log.isDebugEnabled()) {
            log.debug("Received toolResultAssistantContent {}", toolResultAssistantContent);
        }
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onOtherContent(Session session, AssistantContent<?> other) {
        if (log.isDebugEnabled()) {
            log.debug("Received other content {}", other);
        }
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Behavior onPermissionRequest(Session session, CLIControlPermissionRequest permissionRequest) {
        if (Operation.deny.equals(this.defaultPermissionOperation)) {
            log.info("use defaultPermissionOperation Permission denied.");
            return new Deny().setMessage("Permission denied.");
        } else {
            log.info("use defaultPermissionOperation Permission allowed.");
            return new Allow().setUpdatedInput(permissionRequest.getInput());
        }
    }

    @Override
    public ControlResponsePayload onOtherControlRequest(Session session, ControlRequestPayload requestPayload) {
        throw new RuntimeException("need override onOtherControlRequest");
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onUsage(Session session, AssistantUsage AssistantUsage) {
        log.info("received usage {} of message {}", AssistantUsage.getUsage(), AssistantUsage.getMessageId());
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onPermissionRequestTimeout(Session session, CLIControlPermissionRequest permissionRequest) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onOtherControlRequestTimeout(Session session, ControlRequestPayload requestPayload) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onTextTimeout(Session session, TextAssistantContent textAssistantContent) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onThinkingTimeout(Session session, ThinkingAssistantContent thinkingAssistantContent) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onToolUseTimeout(Session session, ToolUseAssistantContent toolUseAssistantContent) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onToolResultTimeout(Session session, ToolResultAssistantContent toolResultAssistantContent) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onOtherContentTimeout(Session session, AssistantContent<?> other) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public AssistantContentSimpleConsumers setDefaultPermissionOperation(Operation defaultPermissionOperation) {
        this.defaultPermissionOperation = defaultPermissionOperation;
        return this;
    }

    /**
     * Constructor.
     *
     * @param defaultPermissionOperation The default permission operation.
     * @param defaultEventTimeout The default event timeout.
     */
    public AssistantContentSimpleConsumers(Operation defaultPermissionOperation, Timeout defaultEventTimeout) {
        this.defaultPermissionOperation = defaultPermissionOperation;
        this.defaultEventTimeout = defaultEventTimeout;
    }

    /**
     * Constructor.
     */
    public AssistantContentSimpleConsumers() {
    }

    /**
     * The default permission operation.
     */
    private Operation defaultPermissionOperation = Operation.deny;

    /**
     * The default event timeout.
     */
    protected Timeout defaultEventTimeout = Timeout.TIMEOUT_60_SECONDS;

    private static final Logger log = LoggerFactory.getLogger(AssistantContentSimpleConsumers.class);
}
