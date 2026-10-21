package ru.tbank.nessy.cli.example;

import ru.tbank.nessy.cli.NessyCLI;
import ru.tbank.nessy.cli.protocol.data.AssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.TextAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ThinkingAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ToolResultAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ToolUseAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantUsage;
import ru.tbank.nessy.cli.protocol.data.PermissionMode;
import ru.tbank.nessy.cli.protocol.data.behavior.Behavior.Operation;
import ru.tbank.nessy.cli.session.Session;
import ru.tbank.nessy.cli.session.event.consumers.AssistantContentSimpleConsumers;
import ru.tbank.nessy.cli.transport.TransportOptions;
import ru.tbank.nessy.cli.utils.Timeout;

import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.TimeUnit;

public class QuickStartExample {
    private static final Logger logger = LoggerFactory.getLogger(QuickStartExample.class);

    public static void main(String[] args) {
        logger.info("runSimpleExample started.{}", StringUtils.repeat("=", 150));
        runSimpleExample();

        logger.info("runTransportOptionsExample started. {}", StringUtils.repeat("=", 150));
        runTransportOptionsExample();

        logger.info("runStreamingExample started. {}", StringUtils.repeat("=", 150));
        runStreamingExample();

        System.exit(0);
    }

    /**
     * Simple example showing basic query usage
     */
    public static void runSimpleExample() {
        List<String> result = NessyCLI.simpleQuery("hello world");
        result.forEach(logger::info);
    }

    /**
     * TransportOptions example showing comprehensive transport options configuration
     */
    public static void runTransportOptionsExample() {
            TransportOptions options = new TransportOptions()
                    .setModel("qwen3-coder-flash")
                    .setPermissionMode(PermissionMode.AUTO_EDIT)
                    .setCwd("./")
                    .setEnv(new HashMap<String, String>() {{put("CUSTOM_VAR", "value");}})
                    .setIncludePartialMessages(true)
                    .setTurnTimeout(new Timeout(120L, TimeUnit.SECONDS))
                    .setMessageTimeout(new Timeout(90L, TimeUnit.SECONDS))
                    .setAllowedTools(Arrays.asList("read_file", "write_file", "list_directory"));

        List<String> result = NessyCLI.simpleQuery("who are you, what are your capabilities?", options);
        result.forEach(logger::info);
    }

    /**
     * Streaming example showing simple query usage
     */
    public static void runStreamingExample() {
        NessyCLI.simpleQuery("who are you, what are your capabilities?",
                new TransportOptions().setMessageTimeout(new Timeout(10L, TimeUnit.SECONDS)), new AssistantContentSimpleConsumers() {

                    @Override
                    public void onText(Session session, TextAssistantContent textAssistantContent) {
                        logger.info("Text content received: {}", textAssistantContent.getText());
                    }

                    @Override
                    public void onThinking(Session session, ThinkingAssistantContent thinkingAssistantContent) {
                        logger.info("Thinking content received: {}", thinkingAssistantContent.getThinking());
                    }

                    @Override
                    public void onToolUse(Session session, ToolUseAssistantContent toolUseContent) {
                        logger.info("Tool use content received: {} with arguments: {}",
                                toolUseContent, toolUseContent.getInput());
                    }

                    @Override
                    public void onToolResult(Session session, ToolResultAssistantContent toolResultContent) {
                        logger.info("Tool result content received: {}", toolResultContent.getContent());
                    }

                    @Override
                    public void onOtherContent(Session session, AssistantContent<?> other) {
                        logger.info("Other content received: {}", other);
                    }

                    @Override
                    public void onUsage(Session session, AssistantUsage assistantUsage) {
                        logger.info("Usage information received: Input tokens: {}, Output tokens: {}",
                                assistantUsage.getUsage().getInputTokens(), assistantUsage.getUsage().getOutputTokens());
                    }
                }.setDefaultPermissionOperation(Operation.allow));
        logger.info("Streaming example completed.");
    }
}
