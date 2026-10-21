package ru.tbank.acp.sdk.protocol.domain.session.update;

import ru.tbank.acp.sdk.protocol.jsonrpc.Meta;

public class AvailableCommand extends Meta {
    private String name;
    private String description;
    private UnstructuredCommandInput input;

    // Getters and setters
    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public UnstructuredCommandInput getInput() {
        return input;
    }

    public void setInput(UnstructuredCommandInput input) {
        this.input = input;
    }
}
