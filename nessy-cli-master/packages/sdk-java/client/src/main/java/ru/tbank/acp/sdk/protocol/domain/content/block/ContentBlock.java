package ru.tbank.acp.sdk.protocol.domain.content.block;

import ru.tbank.acp.sdk.protocol.domain.content.embedded.EmbeddedResource;
import ru.tbank.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeKey = "type", typeName = "ContentBlock", seeAlso = {TextContent.class, ImageContent.class, AudioContent.class, ResourceLink.class, EmbeddedResource.class})
public class ContentBlock extends Meta {
    protected String type;

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }
}
