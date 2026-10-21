package ru.tbank.acp.sdk.protocol.domain.session.update;

import java.util.List;

import ru.tbank.acp.sdk.protocol.domain.plan.PlanEntry;
import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeName = "plan")
public class PlanSessionUpdate extends SessionUpdate {
    private List<PlanEntry> entries;

    public PlanSessionUpdate() {
        this.setSessionUpdate("plan");
    }

    public List<PlanEntry> getEntries() {
        return entries;
    }

    public void setEntries(List<PlanEntry> entries) {
        this.entries = entries;
    }
}
