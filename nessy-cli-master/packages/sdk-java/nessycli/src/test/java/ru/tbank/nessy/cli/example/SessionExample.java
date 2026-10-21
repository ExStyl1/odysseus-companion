package ru.tbank.nessy.cli.example;

import com.alibaba.fastjson2.JSON;
import ru.tbank.nessy.cli.NessyCLI;
import ru.tbank.nessy.cli.protocol.data.AssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.TextAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ThinkingAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ToolResultAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantContent.ToolUseAssistantContent;
import ru.tbank.nessy.cli.protocol.data.AssistantUsage;
import ru.tbank.nessy.cli.protocol.data.behavior.Behavior.Operation;
import ru.tbank.nessy.cli.protocol.message.SDKResultMessage;
import ru.tbank.nessy.cli.protocol.message.SDKSystemMessage;
import ru.tbank.nessy.cli.protocol.message.SDKUserMessage;
import ru.tbank.nessy.cli.protocol.message.assistant.SDKPartialAssistantMessage;
import ru.tbank.nessy.cli.protocol.message.control.CLIControlRequest;
import ru.tbank.nessy.cli.protocol.message.control.CLIControlResponse;
import ru.tbank.nessy.cli.protocol.message.control.payload.ControlRequestPayload;
import ru.tbank.nessy.cli.protocol.message.control.payload.ControlResponsePayload;
import ru.tbank.nessy.cli.session.Session;
import ru.tbank.nessy.cli.session.event.consumers.AssistantContentSimpleConsumers;
import ru.tbank.nessy.cli.session.event.consumers.SessionEventSimpleConsumers;
import ru.tbank.nessy.cli.protocol.data.PermissionMode;
import ru.tbank.nessy.cli.protocol.message.assistant.SDKAssistantMessage;
import ru.tbank.nessy.cli.protocol.message.assistant.block.TextBlock;
import ru.tbank.nessy.cli.session.exception.SessionControlException;

import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Optional;

public class SessionExample {
    private static final Logger logger = LoggerFactory.getLogger(SessionExample.class);

    public static void main(String[] args) {
        Session session = NessyCLI.newSession();
        try {
            logger.info("runPermissionModeExample started {}", StringUtils.repeat("=", 150));
            runPermissionModeExample(session);

            logger.info("runSetModelExample started {}", StringUtils.repeat("=", 150));
            runSetModelExample(session);

            logger.info("runSetPermissionModeExample started {}", StringUtils.repeat("=", 150));
            runSetPermissionModeExample(session);

            logger.info("runInterruptExample started {}", StringUtils.repeat("=", 150));
            runInterruptExample(session);

            logger.info("runSetModelExample started {}", StringUtils.repeat("=", 150));
            runSetModelExample(session);

            logger.info("runPromptUseLowLevelEventExample started {}", StringUtils.repeat("=", 150));
            runPromptUseLowLevelEventExample(session);

            logger.info("runPromptUseHighLevelEventExample started {}", StringUtils.repeat("=", 150));
            runPromptUseHighLevelEventExample(session);

            System.exit(0);
        } finally {
            try {
                session.close();
            } catch (SessionControlException e) {
                logger.error("Error closing session", e);
            }
        }
    }

    /**
     * Example showing how to set different permission modes
     */
    public static void runPermissionModeExample(Session session) {
        try {
            logger.info(session.setPermissionMode(PermissionMode.PLAN).map(s -> s ? "Permission mode set to PLAN" : "Permission mode set error")
                    .orElse("Permission mode set unknown"));
        } catch (SessionControlException e) {
            logger.error("Error setting permission mode", e);
        }
    }

    /**
     * Example showing how to interrupt a running prompt
     */
    public static void runInterruptExample(Session session) {
        try {
            session.sendPrompt("Analyze this large codebase...", new SessionEventSimpleConsumers() {
                @Override
                public void onAssistantMessage(Session session, SDKAssistantMessage assistantMessage) {
                    String message = assistantMessage.getMessage().getContent().stream()
                            .findFirst()
                            .filter(content -> content instanceof TextBlock)
                            .map(content -> ((TextBlock) content).getText())
                            .orElse("");
                    logger.info("Received: {}", message);

                    // Interrupt the session after receiving the first message
                    try {
                        Optional<Boolean> interruptResult = session.interrupt();
                        logger.info("{}", interruptResult.map(s -> s ? "Interrupt successful" : "Interrupt error")
                                .orElse("Interrupt unknown"));
                    } catch (SessionControlException e) {
                        logger.error("Interrupt error: {}", e.getMessage(), e);
                    }
                }
            });
        } catch (Exception e) {
            logger.error("An error occurred while sending the prompt", e);
        }
    }

    /**
     * Example showing how to dynamically change the AI model during a session
     */
    public static void runSetModelExample(Session session) {
        try {
            // Switch to a specific model
            Optional<Boolean> modelChangeResult = session.setModel("qwen3-coder-flash");
            logger.info("{}", modelChangeResult.map(s -> s ? "setModel success" : "setModel error")
                    .orElse("setModel unknown"));

            // Use the model for a prompt
            session.sendPrompt("hello world", new SessionEventSimpleConsumers());

            // Switch to another model
            Optional<Boolean> modelChangeResult2 = session.setModel("qwen3-coder-plus");
            logger.info("{}", modelChangeResult2.map(s -> s ? "setModel success" : "setModel error")
                    .orElse("setModel unknown"));

            // Use the new model for another prompt
            session.sendPrompt("list files in the current directory", new SessionEventSimpleConsumers());
        } catch (Exception e) {
            logger.error("An error occurred while changing model or sending prompt", e);
        }
    }

    /**
     * Example showing how to dynamically change permission mode during a session
     */
    public static void runSetPermissionModeExample(Session session) {
        try {
            // Switch to a permissive mode
            Optional<Boolean> permissionChangeResult = session.setPermissionMode(PermissionMode.AUTO_EDIT);
            logger.info("{}", permissionChangeResult.map(s -> s ? "setPermissionMode success" : "setPermissionMode error")
                    .orElse("setPermissionMode unknown"));

            // Use the session with the new permission mode
            session.sendPrompt("in the dir src/test/temp/, create file empty file test.touch", new SessionEventSimpleConsumers());

            // Switch to another permission mode
            Optional<Boolean> permissionChangeResult2 = session.setPermissionMode(PermissionMode.PLAN);
            logger.info("{}", permissionChangeResult2.map(s -> s ? "setPermissionMode success" : "setPermissionMode error")
                    .orElse("setPermissionMode unknown"));

            // Use the session with the new permission mode
            session.sendPrompt("rename test.touch to test_rename.touch", new SessionEventSimpleConsumers());
        } catch (Exception e) {
            logger.error("An error occurred while changing permission mode or sending prompt", e);
        }
    }

    public static void runPromptUseLowLevelEventExample(Session session) {
        try {
            session.setPermissionMode(PermissionMode.AUTO_EDIT);
            session.sendPrompt("devlop Fibonacci function by python", new SessionEventSimpleConsumers() {
                @Override
                public void onAssistantMessage(Session session, SDKAssistantMessage assistantMessage) {
                    logger.info("Received assistantMessage {}", JSON.toJSONString(assistantMessage));
                }

                @Override
                public void onPartialAssistantMessage(Session session, SDKPartialAssistantMessage partialAssistantMessage) {
                    logger.info("Received partialAssistantMessage {}", JSON.toJSONString(partialAssistantMessage));
                }

                @Override
                public void onUserMessage(Session session, SDKUserMessage userMessage) {
                    logger.info("Received userMessage {}", JSON.toJSONString(userMessage));
                }

                @Override
                public void onOtherMessage(Session session, String message) {
                    logger.info("Received otherMessage {}", message);
                }

                @Override
                public void onControlResponse(Session session, CLIControlResponse<?> cliControlResponse) {
                    logger.info("Received controlResponse {}", JSON.toJSONString(cliControlResponse));
                }

                @Override
                public CLIControlResponse<? extends ControlResponsePayload> onControlRequest(Session session, CLIControlRequest<?> cliControlRequest) {
                    logger.info("Received controlRequest {}", JSON.toJSONString(cliControlRequest));
                    return new CLIControlResponse<>();
                }

                @Override
                public void onResultMessage(Session session, SDKResultMessage resultMessage) {
                    logger.info("Received resultMessage {}", JSON.toJSONString(resultMessage));
                }

                @Override
                public void onSystemMessage(Session session, SDKSystemMessage systemMessage) {
                    logger.info("Received systemMessage {}", JSON.toJSONString(systemMessage));
                }
            });
        } catch (Exception e) {
            logger.error("An error occurred while sending prompt", e);
        }
    }

    public static void runPromptUseHighLevelEventExample(Session session) {
        try {
            session.sendPrompt("devlop Fibonacci function by python", new SessionEventSimpleConsumers().setAssistantContentConsumer(new AssistantContentSimpleConsumers(){
                @Override
                public void onText(Session session, TextAssistantContent textAssistantContent) {
                    logger.info("Received textAssistantContent {}", textAssistantContent.getText());
                }

                @Override
                public void onThinking(Session session, ThinkingAssistantContent thinkingAssistantContent) {
                    logger.info("Received thinkingAssistantContent {}", thinkingAssistantContent.getThinking());
                }

                @Override
                public void onToolUse(Session session, ToolUseAssistantContent toolUseAssistantContent) {
                    logger.info("Received toolUseAssistantContent {}", toolUseAssistantContent.getInput());
                }

                @Override
                public void onToolResult(Session session, ToolResultAssistantContent toolResultAssistantContent) {
                    logger.info("Received toolResultAssistantContent {}", toolResultAssistantContent.getContent());
                }

                @Override
                public void onOtherContent(Session session, AssistantContent<?> other) {
                    logger.info("Received other {}", other);
                }

                @Override
                public void onUsage(Session session, AssistantUsage assistantUsage) {
                    logger.info("Received usage {}", assistantUsage);
                }

                @Override
                public ControlResponsePayload onOtherControlRequest(Session session, ControlRequestPayload requestPayload) {
                    logger.info("Received otherControlRequest {}", requestPayload);
                    return new ControlResponsePayload();
                }
            }.setDefaultPermissionOperation(Operation.allow)));
        } catch (Exception e) {
            logger.error("An error occurred while sending prompt", e);
        }
    }
}
