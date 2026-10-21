package ru.tbank.nessy.cli;

import java.util.ArrayList;
import java.util.List;

import com.alibaba.fastjson2.JSON;
import ru.tbank.nessy.cli.protocol.data.AssistantUsage;
import ru.tbank.nessy.cli.protocol.data.AssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.TextAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ThinkingAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ToolResultAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ToolUseAssistantContent;
import ru.tbank.nessy.cli.protocol.data.behavior.Behavior.Operation;
import ru.tbank.nessy.cli.session.Session;
import ru.tbank.nessy.cli.session.event.consumers.AssistantContentConsumers;
import ru.tbank.nessy.cli.session.event.consumers.AssistantContentSimpleConsumers;
import ru.tbank.nessy.cli.session.event.consumers.SessionEventSimpleConsumers;
import ru.tbank.nessy.cli.transport.Transport;
import ru.tbank.nessy.cli.transport.TransportOptions;
import ru.tbank.nessy.cli.transport.process.ProcessTransport;
import ru.tbank.nessy.cli.utils.MyConcurrentUtils;
import ru.tbank.nessy.cli.utils.Timeout;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Main entry point for interacting with the Nessy CLI. Provides static methods for simple queries and session management.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class NessyCLI {
    private static final Logger log = LoggerFactory.getLogger(NessyCLI.class);

    /**
     * Sends a simple query to the Nessy CLI and returns a list of responses.
     *
     * @param prompt The input prompt to send to the CLI
     * @return A list of strings representing the CLI's responses
     */
    public static List<String> simpleQuery(String prompt) {
        return simpleQuery(prompt, new TransportOptions());
    }

    /**
     * Sends a simple query with custom transport options.
     *
     * @param prompt The input prompt to send to the CLI
     * @param transportOptions Configuration options for the transport layer
     * @return A list of strings representing the CLI's responses
     */
    public static List<String> simpleQuery(String prompt, TransportOptions transportOptions) {
        final List<String> response = new ArrayList<>();
        MyConcurrentUtils.runAndWait(() -> simpleQuery(prompt, transportOptions, new AssistantContentSimpleConsumers() {
            @Override
            public void onText(Session session, TextAssistantContent textAssistantContent) {
                response.add(textAssistantContent.getText());
            }

            @Override
            public void onThinking(Session session, ThinkingAssistantContent thinkingAssistantContent) {
                response.add(thinkingAssistantContent.getThinking());
            }

            @Override
            public void onToolUse(Session session, ToolUseAssistantContent toolUseAssistantContent) {
                response.add(JSON.toJSONString(toolUseAssistantContent.getContentOfAssistant()));
            }

            @Override
            public void onToolResult(Session session, ToolResultAssistantContent toolResultAssistantContent) {
                response.add(JSON.toJSONString(toolResultAssistantContent));
            }

            public void onOtherContent(Session session, AssistantContent<?> other) {
                response.add(JSON.toJSONString(other.getContentOfAssistant()));
            }

            @Override
            public void onUsage(Session session, AssistantUsage assistantUsage) {
                log.info("received usage {} of message {}", assistantUsage.getUsage(), assistantUsage.getMessageId());
            }
        }.setDefaultPermissionOperation(Operation.allow)), Timeout.TIMEOUT_30_MINUTES);
        return response;
    }

    /**
     * Sends a query with custom content consumers.
     *
     * @param prompt The input prompt to send to the CLI
     * @param transportOptions Configuration options for the transport layer
     * @param assistantContentConsumers Consumers for handling different types of assistant content
     */
    public static void simpleQuery(String prompt, TransportOptions transportOptions, AssistantContentConsumers assistantContentConsumers) {
        Session session = newSession(transportOptions);
        try {
            session.sendPrompt(prompt, new SessionEventSimpleConsumers()
                    .setAssistantContentConsumer(assistantContentConsumers));
        } catch (Exception e) {
            throw new RuntimeException("sendPrompt error!", e);
        } finally {
            try {
                session.close();
            } catch (Exception e) {
                log.error("close session error!", e);
            }
        }
    }

    /**
     * Creates a new session with default transport options.
     *
     * @return A new Session instance
     */
    public static Session newSession() {
        return newSession(new TransportOptions());
    }

    /**
     * Creates a new session with custom transport options.
     *
     * @param transportOptions Configuration options for the transport layer
     * @return A new Session instance
     */
    public static Session newSession(TransportOptions transportOptions) {
        Transport transport;
        try {
            transport = new ProcessTransport(transportOptions);
        } catch (Exception e) {
            throw new RuntimeException("initialized ProcessTransport error!", e);
        }

        Session session;
        try {
            session = new Session(transport);
        } catch (Exception e) {
            throw new RuntimeException("initialized Session error!", e);
        }
        return session;
    }
}
