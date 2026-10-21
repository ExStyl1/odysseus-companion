# Nestor A2A v2 wire contract, quota surface, and nessy-desktop intersection map

Date: 2026-08-22. Research inputs for `docs/superpowers/plans/2026-08-22-nestor-cloud-contract-fix.md` (v2-first revision). Produced by workflow `wf_c5e5dff5-fb7` (3 Opus agents) over `.references/nestor-code-completion` @ df526b7, a2a-go `v2@v2.1.0` (go.mod pins v2.3.1 — see the provenance caveat in report 1), `.references/nestor-assistant` @ cfb01c8, and the nessy-desktop tree.

Contents: (1) A2A v1.0 endpoint wire contract; (2) quota surface contract; (3) shared-code intersection map for the v2 flip and /quota.

---



# REPORT 1 — A2A v2 wire contract

# Nestor A2A v2 (`/api/v2/code-agent/a2a`) — client-facing wire contract

## 0. Source provenance (READ FIRST — one gap)

| What | Where |
| --- | --- |
| Backend | `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/.references/nestor-code-completion` |
| A2A core (Nestor's own) | `.../pkg/agentcore/a2a/extensions/`, `.../pkg/agentcore/repo/a2ar/` |
| a2a-go **required** by go.mod | `github.com/a2aproject/a2a-go/v2 v2.3.1` — `.../service/nestor/go.mod:12`, `.../pkg/agentcore/go.mod:6` |
| a2a-go **present on this machine** | `/Users/i.i.gavrikov/go/pkg/mod/github.com/a2aproject/a2a-go/v2@v2.1.0/` |

**No `vendor/` directory exists** in the repo (`ls -d vendor service/nestor/vendor` → no matches). `~/go/pkg/mod/cache/download/github.com/a2aproject/a2a-go/v2/@v/list` contains **only `v2.1.0`**. The legacy indirect module `github.com/a2aproject/a2a-go v0.3.15` (`service/nestor/go.mod:72`) is **not on this machine at all** — `find ~/go/pkg/mod -maxdepth 4 -iname '*a2a*'` returns only the `a2aproject` dir and `v2@v2.1.0`.

⚠️ **Every a2a-go citation below is from `v2@v2.1.0`, not the pinned `v2.3.1`.** v2.1.0's CHANGELOG (`.../v2@v2.1.0/CHANGELOG.md:13-14`) shows two "correct json discriminator keys" fixes landed *in* 2.1.0, so this area has churned. Treat wire details as **v2.1.0-verified, v2.3.1-unverified**. NOT FOUND: any v2.2.x/v2.3.x diff.

---

## 1. ENDPOINTS

### Registration
`service/nestor/internal/httpserver/handler.go:435-450`:

```go
func (h *Handler) registerNessyHandlers(middlewares ...echo.MiddlewareFunc) {
	nessy := echo.WrapHandler(h.useCases.Nessy.GetAgentHandler())
	codeAgentPathV1 := vibe.GetCodeAgentURL("", "v1")
	h.e.POST(codeAgentPathV1, nessy, middlewares...)
	nessyCard := echo.WrapHandler(h.useCases.Nessy.GetCardHandler())
	h.e.GET(codeAgentPathV1+a2asrv.WellKnownAgentCardPath, nessyCard)

	codeAgentPathV2 := vibe.GetCodeAgentURL("", "v2")
	nessyV2 := echo.WrapHandler(h.useCases.Nessy.GetAgentHandlerV2())
	h.e.POST(codeAgentPathV2, nessyV2, middlewares...)
	nessyCardV2 := echo.WrapHandler(h.useCases.Nessy.GetCardHandlerV2())
	h.e.GET(codeAgentPathV2+a2asrv.WellKnownAgentCardPath, nessyCardV2)
}
```

Path builder — `service/nestor/internal/usecase/vibe/usecase_nessy.go:74-84`:
```go
func GetCodeAgentURL(baseURL string, version string) string {
	baseURL = strings.TrimSuffix(baseURL, "/")
	return baseURL + "/" + path.Join("api", version, "code-agent", "a2a")
}
```

`WellKnownAgentCardPath` — `a2asrv/agentcard.go:27`: `const WellKnownAgentCardPath = "/.well-known/agent-card.json"`

**Resulting URLs**

| | v2 |
| --- | --- |
| JSON-RPC POST | `/api/v2/code-agent/a2a` |
| Agent card GET | `/api/v2/code-agent/a2a/.well-known/agent-card.json` |

**Is the card at a well-known path?** No — it is the well-known *suffix* appended to the endpoint path, not the origin-root `/.well-known/agent-card.json`. Same construction as v1.

### Handlers
`usecase_nessy.go:94-102`:
```go
func (c *NessyUseCase) GetAgentHandlerV2() http.Handler {
	return a2asrv.NewJSONRPCHandler(c.requestHandler())
}
func (c *NessyUseCase) GetCardHandlerV2() http.Handler {
	return a2asrv.NewAgentCardHandler(c.getCardProducer("v2", a2a.Version))
}
```
vs v1 (`usecase_nessy.go:85-92`): `a2av0.NewJSONRPCHandler(...)` and `a2av0.NewAgentCardProducer(c.getCardProducer("v1", a2av0.Version))`. **Both wrap the identical `c.requestHandler()`** (`usecase_nessy.go:196-207` — `a2asrv.NewHandler(c, opts...)`).

### Auth — same `nestor-token`
Auth is a **global Echo middleware**, not per-route: `handler.go:335-343` `h.e.Use(authMiddleware(h.useCases.Nestor, skipPaths, blockedPaths))`. Neither `/api/v2/code-agent/a2a` nor its card path is in `skipPaths` (`{"/api/v2/token/introspect", "/mcp/oauth/introspect", "/publication/ready", dpIntegrityVerifyPath}`) or `blockedPaths`. Header read at `service/nestor/internal/httpserver/middleware.go:54`:
```go
token := c.Request().Header.Get("nestor-token")
if token == "" { return echo.NewHTTPError(http.StatusUnauthorized, "Empty token") }
```
So: **same `Nestor-Token: <JWT>` header, and the v2 agent-card GET also requires it** (401 otherwise, when `cfg.AuthMiddlewareEnabled`).

Per-route middlewares for the A2A endpoints — `handler.go:331`: `h.registerNessyHandlers(traceMiddleware, userLimitMiddleware(h.limiters.Qwen35))`. These apply to the **POST only**; the card GET is registered without them.

---

## 2. JSON-RPC METHODS ON v2 — **all method names changed**

`internal/jsonrpc/jsonrpc.go:32-44` (a2a-go v2.1.0):
```go
	// JSON-RPC method names per A2A spec §7
	MethodMessageSend          = "SendMessage"
	MethodMessageStream        = "SendStreamingMessage"
	MethodTasksGet             = "GetTask"
	MethodTasksList            = "ListTasks"
	MethodTasksCancel          = "CancelTask"
	MethodTasksResubscribe     = "SubscribeToTask"
	MethodPushConfigGet        = "GetTaskPushNotificationConfig"
	MethodPushConfigSet        = "CreateTaskPushNotificationConfig"
	MethodPushConfigList       = "ListTaskPushNotificationConfigs"
	MethodPushConfigDelete     = "DeleteTaskPushNotificationConfig"
	MethodGetExtendedAgentCard = "GetExtendedAgentCard"
```

vs the 0.3 names still served on v1 — `a2acompat/a2av0/jsonrpc.go:17-28`: `"message/send"`, `"message/stream"`, `"tasks/get"`, `"tasks/cancel"`, `"tasks/resubscribe"`, `"tasks/pushNotificationConfig/{get,set,list,delete}"`, `"agent/getAuthenticatedExtendedCard"`.

| Client need | v2 method | Params type / JSON | Citation |
| --- | --- | --- | --- |
| **Streaming send** | `"SendStreamingMessage"` | `a2a.SendMessageRequest` | `a2asrv/jsonrpc.go:78-82`, `:158-166` |
| Non-streaming send | `"SendMessage"` | `a2a.SendMessageRequest` | `a2asrv/jsonrpc.go:105-110` |
| **Cancel** | `"CancelTask"` | `a2a.CancelTaskRequest` = `{"id": "<taskId>", "tenant"?: string, "metadata"?: object}` | `a2asrv/jsonrpc.go:111-112`; `a2a/core.go:871-881` |
| **Resubscribe after dropped stream** | `"SubscribeToTask"` | `a2a.SubscribeToTaskRequest` = `{"id": "<taskId>", "tenant"?: string}` | `a2asrv/jsonrpc.go:78`, `:283-296`; `a2a/core.go:893-900` |
| Fetch a task | `"GetTask"` | `{"id": string, "tenant"?: string, "historyLength"?: int}` | `a2a/core.go:810-819` |
| **List tasks (NEW in v2)** | `"ListTasks"` | `{"tenant"?, "contextId"?, "status"?, "pageSize"?, "pageToken"?, "historyLength"?, "statusTimestampAfter"?, "includeArtifacts"?}` | `a2asrv/jsonrpc.go:101-102`; `a2a/core.go:823-853` |

Routing: only `SubscribeToTask` and `SendStreamingMessage` go down the SSE path — `a2asrv/jsonrpc.go:78-82`:
```go
	if payload.Method == jsonrpc.MethodTasksResubscribe || payload.Method == jsonrpc.MethodMessageStream {
		h.handleStreamingRequest(ctx, rw, &payload)
```

`ListTasks` is backed by a real Nestor implementation (`pkg/agentcore/repo/a2ar/a2a_repo_task_store.go:176`), so it is usable, unlike on v1 where the method does not exist in the compat switch (`a2acompat/a2av0/jsonrpc_server.go:100-120` has **no** `ListTasks` case).

---

## 3. REQUEST SHAPE

### Serialization layer — **plain `encoding/json` struct tags, camelCase. NOT protojson.**
`a2asrv/jsonrpc.go` uses `json.NewDecoder(req.Body).Decode(&payload)` (`:63`), `json.Unmarshal` per method (`:250-…`), and `json.Encoder`/`json.Marshal` on the way out (`:132`, `:238`). `grep -rn protojson` over `a2asrv/`, `a2a/`, `internal/jsonrpc/` returns **nothing**. (`a2apb/` exists but is the gRPC binding, not this path.) Casing therefore comes from the Go tags, which are camelCase — see below. Extension payloads *inside* `metadata`/`data` keep their own **snake_case** (they are Nestor structs with explicit `json:"tool_call_id"`-style tags).

### `SendMessageRequest` (params of `SendMessage` / `SendStreamingMessage`)
`a2a/core.go:772-785`:
```go
	Tenant   string             `json:"tenant,omitempty"`
	Config   *SendMessageConfig `json:"configuration,omitempty"`
	Message  *Message           `json:"message"`
	Metadata map[string]any     `json:"metadata,omitempty"`
```
`SendMessageConfig` (`a2a/core.go:757-770`): `acceptedOutputModes`, **`returnImmediately`** (bool), `historyLength`, `pushNotificationConfig`. Note 0.3's `blocking` is gone — the compat layer computes `req.Config.ReturnImmediately = !(*p.Config.Blocking)` (`a2acompat/a2av0/conversions.go:649-651`), i.e. **`returnImmediately` is the logical inverse of 0.3 `blocking`**.

### `Message` — `a2a/core.go:196-224`
```go
	ID             string         `json:"messageId"`
	ContextID      string         `json:"contextId,omitempty"`
	Extensions     []string       `json:"extensions,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
	Parts          ContentParts   `json:"parts"`
	ReferenceTasks []TaskID       `json:"referenceTaskIds,omitempty"`
	Role           MessageRole    `json:"role"`
	TaskID         TaskID         `json:"taskId,omitempty"`
```
- `messageId` — **camelCase, not `message_id`**.
- **`contextId` and `taskId` ride on the message object itself** (not in `configuration`, not at params root).
- **`metadata` rides on the message object** — that is where all the Nestor metadata extensions go (see §5).
- `metadata` *also* exists at the params root (`SendMessageRequest.Metadata`) — a separate map, surfaced to the executor as `ExecutorContext.Metadata` (`a2asrv/agentexec.go:224`, `:249`). Nestor's `createCodeAgentSpec` reads extensions **only** from message metadata via the history (`usecase_nessy_execution.go:181-206`), so put extensions on the **message**.

### `role` — enum strings, **changed from 0.3**
`a2a/core.go:152-158`:
```go
	MessageRoleUnspecified MessageRole = ""
	MessageRoleAgent       MessageRole = "ROLE_AGENT"
	MessageRoleUser        MessageRole = "ROLE_USER"
```
Marshals via `MarshalJSON` → `"ROLE_USER"` / `"ROLE_AGENT"` / `"ROLE_UNSPECIFIED"` (`a2a/core.go:161-172`). Our current client sends `role: 'user'` on 0.3 (`packages/shared/src/agent/backend/nestor-cloud/types.ts` role fields; request built in `packages/shared/src/agent/backend/nestor-cloud/client.ts:171-176`). On v2 you **must send `"ROLE_USER"`** — `UnmarshalJSON` accepts any string, so `"user"` would pass the non-empty check at `a2asrv/handler.go:359` but then fall through `toDomainRole`'s `default:` to `chat.RoleAssistant` (`service/nestor/internal/usecase/vibe/mapping/message.go:93-101`) — silent wrong-role corruption.

### Parts — **flattened oneof, no `kind` discriminator**
`a2a/core.go:578-593` + custom marshaller `a2a/core.go:672-697`:
```go
	switch v := p.Content.(type) {
	case Text: m["text"] = string(v)
	case Raw:  m["raw"] = []byte(v)
	case Data: m["data"] = v.Value
	case URL:  m["url"] = string(v)
	}
	if p.Filename != ""  { m["filename"] = p.Filename }
	if p.MediaType != "" { m["mediaType"] = p.MediaType }
	if len(p.Metadata) > 0 { m["metadata"] = p.Metadata }
```
Golden fixture — `a2a/json_test.go:43-58`:
```
{"text":"hello, world"}
{"data":{"foo":"bar"}}
{"filename":"foo","url":"https://cats.com/1.png"}
{"filename":"foo","mediaType":"image/png","raw":"//4="}
{"metadata":{"foo":"bar"},"text":"42"}
```
Unmarshal discriminates by key presence in order `text` → `raw` (base64) → `data` → `url` (`a2a/core.go:700-716`). A stray `"kind":"text"` is **ignored, not rejected** (it is simply left in the `raw` map and dropped) — see `a2a/event_json_test.go:129` which feeds `{"kind":"text","text":"hello"}` and asserts success. But **0.3's `{"kind":"file","file":{...}}` is NOT recognized** — no `file` branch exists; such a part decodes with `Content == nil`.

**Full example v2 streaming request:**
```json
{"jsonrpc":"2.0","id":"1","method":"SendStreamingMessage","params":{
  "message":{
    "messageId":"018f...","role":"ROLE_USER",
    "contextId":"ctx-1","taskId":"task-1",
    "parts":[{"text":"fix the bug"},{"data":{"data_type":"tool_result","data_version":1,"tool_call_id":"c1","content":"ok"}}],
    "metadata":{"environment_details":{...},"agent_settings":{"data_type":"agent_settings","data_version":1,"mode":"act"}}
  }}}
```
(Envelope keys `jsonrpc`/`method`/`params`/`id` — `internal/jsonrpc/jsonrpc.go:151-157`; `id` must be string or number, `IsValidID` at `:139-149`.)

---

## 4. STREAM EVENT ENCODING

### Transport framing
SSE, `a2asrv/jsonrpc.go:138-142` → `internal/sse/sse.go:57-64` headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`), and each frame written at `internal/sse/sse.go:75-85`:
```go
	fmt.Fprintf(w.writer, "%s %s\n", sseIDPrefix, []byte(eventID))   // "id: <uuid>"
	fmt.Fprintf(w.writer, "%s %s\n\n", sseDataPrefix, data)          // "data: <json>\n\n"
```
Keep-alive comment `": keep-alive\n\n"` (`internal/sse/sse.go:67`) only when `KeepAliveInterval > 0`; Nestor does not pass `a2asrv.WithKeepAlive*` (`usecase_nessy.go:196-207` — options are TaskStore, Logger, ExecutionPanicHandler, CallInterceptors, ExecutorContextInterceptor only), so **NOT enabled**.

Each `data:` payload is a full JSON-RPC response — `a2asrv/jsonrpc.go:236`:
```go
resp := jsonrpc.ServerResponse{JSONRPC: jsonrpc.Version, ID: req.ID, Result: a2a.StreamResponse{Event: event}}
```

### The oneof envelope — key-based, **no `kind` field**
`a2a/core.go:93-109`:
```go
func (sr StreamResponse) MarshalJSON() ([]byte, error) {
	m := make(map[string]any)
	switch v := sr.Event.(type) {
	case *Message:                 m["message"] = v
	case *Task:                    m["task"] = v
	case *TaskStatusUpdateEvent:   m["statusUpdate"] = v
	case *TaskArtifactUpdateEvent: m["artifactUpdate"] = v
	default: return nil, fmt.Errorf("unknown event type: %T", v)
	}
	return json.Marshal(m)
}
```
**Client discriminates by which of the four keys is present** — the mirror decoder does exactly that (`a2a/core.go:112-146`), and errors `"unknown event type"` if none matches. Exact keys: **`message`, `task`, `statusUpdate`, `artifactUpdate`** (vs 0.3's `kind: "message" | "task" | "status-update" | "artifact-update"` that our client parses today — `packages/shared/src/agent/backend/nestor-cloud/types.ts:47,54,62,69`).

Marshal assertions — `a2a/event_json_test.go:41-77`: `` `"message":` ``, `` `"task":` ``, `` `"statusUpdate":` ``, `` `"artifactUpdate":` ``.

### Status-update shape
`a2a/core.go:515-528`:
```go
	ContextID string         `json:"contextId"`
	Status    TaskStatus     `json:"status"`
	TaskID    TaskID         `json:"taskId"`
	Metadata  map[string]any `json:"metadata,omitempty"`
```
`TaskStatus` (`a2a/core.go:380-388`): `message` (optional `*Message`), **`state`**, `timestamp` (RFC3339, optional).

**There is NO `final` field on v2.** The struct has no such member; the golden fixture `a2a/event_json_test.go:163` feeds `"final":false` and it is simply discarded. The 0.3 `final` is *synthesised by the compat layer only* — `a2acompat/a2av0/conversions.go:485`:
```go
		Final: e.Status.State.Terminal() || e.Status.State == a2a.TaskStateInputRequired,
```
**Client must compute the same predicate itself on v2.** `Terminal()` is defined at `a2a/core.go:327-332`:
```go
	return ts == TaskStateCompleted || ts == TaskStateCanceled || ts == TaskStateFailed || ts == TaskStateRejected
```

### Full `TASK_STATE_*` value list — `a2a/core.go:272-292`
| Constant | JSON value |
| --- | --- |
| `TaskStateUnspecified` | `"TASK_STATE_UNSPECIFIED"` (marshalled from `""` via `String()`, `a2a/core.go:295-300`) |
| `TaskStateAuthRequired` | `"TASK_STATE_AUTH_REQUIRED"` |
| `TaskStateCanceled` | `"TASK_STATE_CANCELED"` |
| `TaskStateCompleted` | `"TASK_STATE_COMPLETED"` |
| `TaskStateFailed` | `"TASK_STATE_FAILED"` |
| `TaskStateInputRequired` | `"TASK_STATE_INPUT_REQUIRED"` |
| `TaskStateRejected` | `"TASK_STATE_REJECTED"` |
| `TaskStateSubmitted` | `"TASK_STATE_SUBMITTED"` |
| `TaskStateWorking` | `"TASK_STATE_WORKING"` |

Which of these Nestor actually emits: `TASK_STATE_SUBMITTED` (`usecase_nessy_execution.go:86,100`), `TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_COMPLETED` (`service/nestor/internal/usecase/vibe/agent/a2a_environment.go:157-178`), `TASK_STATE_CANCELED` (`usecase_nessy_execution.go:73-77`).

### Artifact shape
`Artifact` — `a2a/core.go:417-432`: `artifactId`, `description?`, `extensions?`, `metadata?`, `name?`, `parts`.
`TaskArtifactUpdateEvent` — `a2a/core.go:452-467`: `append?` (bool), `artifact`, `contextId`, `lastChunk?` (bool), `taskId`, `metadata?`.

### Concrete frames (reconstructed from the marshallers + `a2a/event_json_test.go` fixtures)

**`task`** — from `a2a.NewSubmittedTask` (`usecase_nessy_execution.go:86`, ctor at `a2a/core.go:361-377`):
```
id: 3f0c…
data: {"jsonrpc":"2.0","id":"1","result":{"task":{"id":"task-123","contextId":"ctx-123","status":{"state":"TASK_STATE_SUBMITTED"},"history":[{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"hi"}]}]}}}
```
(fixture keys `"task":` + `"id":"task-123"` — `a2a/event_json_test.go:44-53`; decode fixture `a2a/event_json_test.go:146`)

**`statusUpdate`**:
```
data: {"jsonrpc":"2.0","id":"1","result":{"statusUpdate":{"contextId":"ctx-123","taskId":"task-123","status":{"state":"TASK_STATE_WORKING","timestamp":"2026-08-22T10:00:00Z","message":{"messageId":"m2","role":"ROLE_AGENT","taskId":"task-123","contextId":"ctx-123","parts":[{"data":{"data_type":"tool_call","data_version":1,"index":0,"id":"c1","function":{"name":"read_file","arguments":"{}"}}}],"metadata":{"request_details":{"data_type":"request_details","data_version":1,"request_id":"…"},"invocation_id":"…"},"extensions":["urn:a2a:extension:request-details:v1"]}}}}}
```
(fixture keys `"statusUpdate":` + `"taskId":"task-123"` — `a2a/event_json_test.go:54-65`; decode fixture `a2a/event_json_test.go:163`. Message assembly: `a2aextensions.MakeResponseMessage` + `mapping.SetInvocationID` + `a2a.NewStatusUpdateEvent` — `a2a_environment.go:202-215`.)

**`artifactUpdate`** — Nestor emits these for server-tool status (`service/nestor/internal/usecase/vibe/mapping/status.go:48` `a2a.NewArtifactEvent(info, part)`):
```
data: {"jsonrpc":"2.0","id":"1","result":{"artifactUpdate":{"contextId":"ctx-123","taskId":"task-123","artifact":{"artifactId":"art-123","parts":[{"data":{"data_type":"server_tool_status","data_version":1,"tool_call_id":"c1","name":"doc_search","state":"started","description":"Searching"}}]}}}}
```
(fixture keys `"artifactUpdate":` + `"taskId":"task-123"` — `a2a/event_json_test.go:66-77`; decode fixture `a2a/event_json_test.go:180`)

**`message`**:
```
data: {"jsonrpc":"2.0","id":"1","result":{"message":{"messageId":"msg-123","role":"ROLE_AGENT","parts":[{"text":"hello"}]}}}
```
(fixture `a2a/event_json_test.go:36-42`, decode fixture `a2a/event_json_test.go:129`)

**Note on non-streaming `SendMessage`:** v2 wraps the result in the same envelope — `a2asrv/jsonrpc.go:105-110` `result = a2a.StreamResponse{Event: res}` → `{"result":{"task":{…}}}`. The 0.3 path returns the bare object (`a2acompat/a2av0/jsonrpc_server.go:262-284`). This is a v2-only extra nesting level.

---

## 5. EXTENSIONS PARITY — **shared layer, zero rename, identical on v2**

The extension layer lives entirely in Nestor and is written against **v2 native types** (`github.com/a2aproject/a2a-go/v2/a2a`). It is **not duplicated per version**: both `GetAgentHandler()` (v1) and `GetAgentHandlerV2()` wrap the *same* `c.requestHandler()` → `a2asrv.NewHandler(c, …)` with `c` = `*NessyUseCase` as the single `AgentExecutor` (`usecase_nessy.go:85-96`, `:196-207`). `a2acompat/a2av0` only translates JSON⇄v2-Go at the transport edge; it never touches `metadata` or `data` contents (`a2acompat/a2av0/conversions.go:255` `Metadata: m.Metadata` — pass-through).

### Metadata extensions (`message.metadata[<key>]`)
Applied by `extensions.GetMetaObjectForKey` / `GetMetaSliceForKey` / `AddMetaToMessage` — `pkg/agentcore/a2a/extensions/metadata.go:21`, `:41`, `:61`. Keys:

| Client key (`metadata-builder.ts`) | Backend constant | Citation | v2 identical? |
| --- | --- | --- | --- |
| `environment_details` | `dataEnvironmentField = "environment_details"` | `a2aextensions/environment_data_extension.go:16`, read at `:82` | ✅ |
| `agent_settings` | `dataSettingsField = "agent_settings"` | `a2aextensions/agent_settings_extension.go:16`, read at `:69` | ✅ |
| `agents_md` | `dataAgentsMdField = "agents_md"` | `pkg/agentcore/a2a/extensions/agents_md_extension.go:14`, read at `:61` | ✅ |
| `mcp` | `mcpField = "mcp"` | `pkg/agentcore/a2a/extensions/tool_mcp.go:9`, read at `:31` (slice) | ✅ |
| `skills` | `dataSkillsField = "skills"` | `a2aextensions/skills_extension.go:16`, read at `:63` (slice) | ✅ |
| `workspace_tabs` | `dataWorkspaceTabsField = "workspace_tabs"` | `a2aextensions/open_tabs_extension.go:16`, read at `:69` | ✅ |
| `request_details` (agent→client) | `dataRequestDetailsField = "request_details"` | `a2aextensions/request_details_extension.go:18`, written at `:64` | ✅ |
| `invocation_id` (agent→client, plain string) | `InvocationIDKey = "invocation_id"` | `mapping/message.go:19`, `:88-90` | ✅ |

Consumption is version-agnostic — `usecase_nessy_execution.go:181-206` reads all six client-supplied keys off `a2aexeccontext.GetTaskHistory(execCtx)` regardless of which transport produced it.

### `data_type` envelope
`pkg/agentcore/a2a/extensions/versioned.go:11-14, 37-46`:
```go
type VersionHeader struct {
	DataType    DataType `json:"data_type" validate:"required"`
	DataVersion int      `json:"data_version" validate:"required"`
}
…
	marshaled["data_type"] = string(value.GetType())
	marshaled["data_version"] = value.GetVersion()
```
Injected identically for **both** metadata objects (`AddMetaToMessage` → `encodeVersionedData`, `metadata.go:61-72`) and data parts (`EncodeDataPart` → `a2a.NewDataPart(encoded)`, `data_part.go:32-38`). One code path, no version branch.

### Data-part extensions

| `data_type` value | Struct fields (verbatim JSON) | Citation |
| --- | --- | --- |
| `"tool_call"` | `index`, `id`, `function{name,arguments}` | `tool_call.go:8-18` |
| `"tool_result"` | **`tool_call_id`**, **`content`**, **`error`** (`error,omitempty`) | `tool_result.go:7-13` |
| `"retryable_error"` | `id`, `error{code,message}` | `retryable_error_extension.go:20-30` |
| `"server_tool_status"` | `tool_call_id`, `name`, `state`, `description` | `server_tool_status.go:8-20` |
| `"server_tool_invocation"` | `call{…ToolCallV1}`, `result{…ToolResultV1}` | `server_tool_invocation.go:7-12` |
| `"mcp_tool"` | `type`, `name`, `description`, `parameters` | `tool_mcp.go:11-18` |
| `"agents_md"` | — | `agents_md_extension.go:20` |
| `"reasoning"` | — | `reasoning_data_extension.go:17` |
| `"doc_search_result"` | — | `a2aextensions/constants.go:6` |
| `"skill"` | — | `a2aextensions/constants.go:10` |
| `"request_details"` | `request_id` | `a2aextensions/constants.go:11`; `request_details_extension.go:60-65` |

`request_details` (client-side name) rides as **metadata**, not a data part — `SetRequestDetailsMetadata` calls `AddMetaToMessage(msg, reqDetails, dataRequestDetailsField)` (`request_details_extension.go:64`).

`ServerToolStatusState` has exactly one value: `ServerToolStatusStateStarted = "started"` (`server_tool_status.go:8-11`).

### ❌ `context_usage` and `compaction` — **NOT FOUND in the Nestor backend**
`grep -rn "context_usage\|compaction\|ContextUsage\|Compaction" --include='*.go' .` over the whole `nestor-code-completion` repo returns **zero hits**. Our client parses `data.type === 'context_usage'` / `'compaction_start'` / `'compaction_end'` (`packages/shared/src/agent/backend/nestor-cloud/event-adapter.ts:255,297,301`) — and note the discriminator there is `type`, not `data_type`, which does not match Nestor's envelope at all. These two are **not part of the Nestor contract on either v1 or v2**; they are dead on both paths as far as this backend is concerned.

### The one real risk on v2: primitive data parts
`a2a.Data{Value: any}` on v2 carries **any** JSON value. The 0.3 compat writer wraps non-maps: `a2acompat/a2av0/conversions.go:369-379` sets `{"value": …}` + `metadata["data_part_compat"]=true`. Nestor's own `ExtractDataMap` only accepts `map[string]any` (`data_part.go:19-30`), so all Nestor-produced parts are objects and this never fires today — but a v2 client may now **send** a primitive `data` and it will reach the executor as `ErrPartDataFormatInvalid` rather than being silently wrapped.

---

## 6. ERROR SHAPES ON v2 — **same `ToJSONRPCError` mapping**

Both transports call the identical function: `a2asrv/jsonrpc.go:335, 355` and `a2acompat/a2av0/jsonrpc_server.go:352, 371` → `jsonrpc.ToJSONRPCError(err)`.

Error object — `internal/jsonrpc/jsonrpc.go:50-54`:
```go
type Error struct {
	Code    int            `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}
```

Code table — `internal/jsonrpc/jsonrpc.go:64-81`:
| Code | Sentinel | `message` string (`a2a/errors.go`) |
| --- | --- | --- |
| `-32700` | `ErrParseError` | `"parse error"` |
| `-32600` | `ErrInvalidRequest` | `"invalid request"` |
| `-32601` | `ErrMethodNotFound` | `"method not found"` |
| `-32602` | `ErrInvalidParams` | `"invalid params"` |
| `-32603` | `ErrInternalError` | `"internal error"` |
| `-32000` | `ErrServerError` | `"server error"` |
| `-32001` | `ErrTaskNotFound` | `"task not found"` |
| `-32002` | `ErrTaskNotCancelable` | `"task cannot be canceled"` |
| `-32003` | `ErrPushNotificationNotSupported` | `"push notification not supported"` |
| `-32004` | `ErrUnsupportedOperation` | `"this operation is not supported"` |
| `-32005` | `ErrUnsupportedContentType` | `"incompatible content types"` |
| `-32006` | `ErrInvalidAgentResponse` | `"invalid agent response"` |
| `-32007` | `ErrExtendedCardNotConfigured` | `"extended card not configured"` |
| `-32008` | `ErrExtensionSupportRequired` | `"extension support required"` |
| `-32009` | `ErrVersionNotSupported` | `"this version is not supported"` |
| `-31401` | `ErrUnauthenticated` | `"unauthenticated"` |
| `-31403` | `ErrUnauthorized` | `"permission denied"` |

Mapping rule for a wrapped sentinel — `internal/jsonrpc/jsonrpc.go:122-131`:
```go
	for code, a2aErr := range codeToError {
		if errors.Is(err, a2aErr) {
			return &Error{Code: code, Message: a2aErr.Error(), Data: map[string]any{"error": err.Error()}}
		}
	}
	return &Error{Code: -32603, Message: a2a.ErrInternalError.Error(), Data: map[string]any{"error": err.Error()}}
```

### **`-32029` is NOT a JSON-RPC error on either version**
It is a *payload* code inside a `retryable_error` **data part**, not a transport error — `pkg/agentcore/a2a/extensions/retryable_error_extension.go:55-62`:
```go
	case errors.Is(errorEvent, ErrRateLimitError):
		errorData = ErrorData{Code: -32029, Message: "Inference rate limit error occurred, please try again later"}
```
with siblings `-32000 "Inference error occurred"`, `-32000 "Task was unexpectedly aborted"`, `-32603 "Internal agent error"` (`:63-73`). It arrives as a `statusUpdate` with `TASK_STATE_WORKING` carrying the error part, immediately followed by a `TASK_STATE_INPUT_REQUIRED` update — `a2a_environment.go:157-165`. Identical on v2 (shared executor).

### Terminal task — **where the TASK_STATE lands**
`a2asrv/agentexec.go:201-203`:
```go
	if storedTask.Status.State.Terminal() {
		return nil, fmt.Errorf("task in a terminal state %q: %w", storedTask.Status.State, a2a.ErrInvalidParams)
	}
```
further wrapped at `internal/taskexec/local_manager.go:148-151` (`"create execution failure: %w"`). Through `ToJSONRPCError` that yields **code `-32602`, `message: "invalid params"`**, and the state string lands **only inside `error.data.error`**:
```json
{"jsonrpc":"2.0","id":"1","error":{"code":-32602,"message":"invalid params",
 "data":{"error":"create execution failure: task in a terminal state \"TASK_STATE_COMPLETED\": invalid params"}}}
```
A client must **string-parse `data.error`** to recover the state — there is no structured field. Identical on v1.

### Other concrete cases
- **Task not found**: store returns `a2a.ErrTaskNotFound` (`pkg/agentcore/repo/a2ar/a2a_repo_task_store.go:145`, `:86`); wrapped `"task loading failed: %w"` (`a2asrv/agentexec.go:184-185`) → `-32001` / `"task not found"`. On `SubscribeToTask` it is re-wrapped explicitly at `a2asrv/handler.go:336`.
- **Non-cancelable**: `a2asrv/agentexec.go:262-264` → `-32002` / `"task cannot be canceled"`.
- **Invalid params (validation)**: `a2asrv/handler.go:349-360` — missing params / `message` / `message.messageId` / `message.parts` / `message.role` all → `-32602`.
- **Unknown method** → `-32601` (`a2asrv/jsonrpc.go:122`); **empty method** → `-32600` (`:120`).
- **Bad JSON** → `handleUnmarshalError` (`a2asrv/jsonrpc.go:344-350`): `*json.UnmarshalTypeError` → `-32602`, else `-32700`.
- **Non-POST** → `-32600` (`a2asrv/jsonrpc.go:51-54`).
- HTTP status is **always 200** for JSON-RPC-level errors (`a2asrv/jsonrpc_test.go:266-268` asserts `resp.StatusCode == 200`).
- **Errors mid-stream** are delivered as an SSE `data:` frame carrying `{"jsonrpc":"2.0","id":…,"error":{…}}` and the stream then ends (`a2asrv/jsonrpc.go:213-224`).
- Panics: Nestor installs `WithExecutionPanicHandler` returning `a2a.ErrInternalError` (`usecase_nessy.go:209-215`) → `-32603`.

---

## 7. CARD v2

Producer — `usecase_nessy.go:104-190` (called with `handlerVersion="v2"`, `protocol=a2a.Version`).

### `protocolVersion` — **value `"1.0"`, moved into `supportedInterfaces[]`**
`a2a/core.go:32`: `const Version ProtocolVersion = "1.0"`.
`a2a.AgentCard` has **no top-level `protocolVersion`** — the full tag list is at `a2a/agent.go:46-89`: `supportedInterfaces`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, `description`, `documentationUrl?`, `iconUrl?`, `name`, `provider?`, `securityRequirements?`, `securitySchemes?`, `signatures?`, `skills`, `version`. It lives per-interface (`a2a/agent.go:136`): `ProtocolVersion ProtocolVersion \`json:"protocolVersion"\``.

On the v1 card the compat producer re-adds the root field as `"protocolVersion":"0.3"` (`a2acompat/a2av0/agentcard.go:117` `ProtocolVersion: Version`; `a2acompat/a2av0/doc.go:20` `const Version a2a.ProtocolVersion = "0.3"`), plus root `url` / `preferredTransport` / `additionalInterfaces` (`agentcard.go:341-345`). **All four are absent from the v2 card.**

### `supportedInterfaces` shape
`a2a/agent.go:124-136` — `AgentInterface{ url, protocolBinding, tenant?, protocolVersion }`. `TransportProtocol` values (`a2a/agent.go:190-195`): `"JSONRPC"`, `"GRPC"`, `"HTTP+JSON"`.

Nestor emits exactly one (`usecase_nessy.go:181-188`):
```json
"supportedInterfaces":[{"url":"<serverURL>/api/v2/code-agent/a2a","protocolBinding":"JSONRPC","protocolVersion":"1.0"}]
```

### `capabilities.streaming`
`usecase_nessy.go:174-177`: `Capabilities: a2a.AgentCapabilities{Streaming: true, Extensions: a2aExtensions}` → `"capabilities":{"streaming":true,"extensions":[…]}`. Tag: `a2a/agent.go:26` `Streaming bool \`json:"streaming,omitempty"\``. `pushNotifications` and `extendedAgentCard` are unset → omitted.

### Composer-modes extension — **YES, identical**
The card carries `capabilities.extensions[]` (`a2a/agent.go:20`, `AgentExtension{uri, description?, params?, required?}` at `a2a/agent.go:106-118`) built by the **same** `getCardProducer` for both versions. Ten extensions, appended in this order (`usecase_nessy.go:106-165`): tool-data, environment-data, agent-settings, agents-md, retryable-error, skills, workspace-tabs, request-details, reasoning-data, doc-search-result.

URIs:
```
urn:a2a:extension:tool-data:v1            pkg/agentcore/a2a/extensions/tool_data_extension.go:13
urn:a2a:extension:environment-data:v1     a2aextensions/environment_data_extension.go:54
urn:a2a:extension:agent-settings:v1       a2aextensions/agent_settings_extension.go:40
urn:a2a:extension:agents-md:v1            pkg/agentcore/a2a/extensions/agents_md_extension.go:32
urn:a2a:extension:retryable-error:v1      pkg/agentcore/a2a/extensions/retryable_error_extension.go:37
urn:a2a:extension:skills:v1               a2aextensions/skills_extension.go:37
urn:a2a:extension:workspace-tabs:v1       a2aextensions/open_tabs_extension.go:33
urn:a2a:extension:request-details:v1      a2aextensions/request_details_extension.go:34
urn:a2a:extension:reasoning-data:v1       pkg/agentcore/a2a/extensions/reasoning_data_extension.go:24
urn:a2a:extension:doc-search-result:v1    a2aextensions/doc_search_result_extension.go:17
```

Our `agent-card-modes.ts` looks for `urn:a2a:extension:agent-settings:v1` (`packages/shared/src/agent/backend/nestor-cloud/agent-card-modes.ts:4, 46-53`) and reads `extension.params.agentSettingsSchema.properties.mode.enum` (`:69-79`). The backend params come from the embedded schema `service/nestor/internal/usecase/vibe/a2aextensions/agent_settings_schema.json`:
```json
{"agentSettingsSchema":{"type":"object","properties":{"data_type":{"const":"agent_settings"},"data_version":{"const":1},"mode":{"type":"string","enum":["plan","act"],…},"user_instructions":{…}},"required":["mode"]}}
```
loaded verbatim into `Params` at `agent_settings_extension.go:42-57`. **Byte-identical on v2.**

⚠️ One structural caveat: our parser also accepts `card.extensions` / `card.extension` at the **root** (`agent-card-modes.ts:56-66`). On both v1 and v2 the array is nested at **`capabilities.extensions`** (`a2a/agent.go:20`), so whichever path works today keeps working — but confirm the client actually reads `card.capabilities.extensions`.

### Other card fields (`usecase_nessy.go:167-189`)
`name: "Code Agent"`, `description: "Agent that can help generate code"`, one skill `{id:"tool-execution", name:"Tool Execution", description:"Execute client tool calls and return results", tags:["tools","execution"]}`, `defaultInputModes` / `defaultOutputModes` = `["application/json","text/plain"]`. **`version` is never set** → the card serialises `"version":""` (tag has no `omitempty`, `a2a/agent.go:89`).

Card transport: `Content-Type: application/json`, CORS `Access-Control-Allow-Origin` echoing `Origin` or `*` (`a2asrv/agentcard.go:165-186`); `OPTIONS` answered, non-GET → `405` (`a2asrv/agentcard.go:108-118`).

---

## 8. WHAT v2 GAINS / REQUIRES

### Gains (dropped or transformed by the 0.3-compat layer, exposed natively on v2)

1. **`ListTasks` method** — exists in the v2 switch (`a2asrv/jsonrpc.go:101-102`) with a real store impl (`pkg/agentcore/repo/a2ar/a2a_repo_task_store.go:176`); **completely absent** from the a2av0 switch (`a2acompat/a2av0/jsonrpc_server.go:100-120`). New capability: paginate a context's task history (`contextId`, `pageSize`, `pageToken`, `statusTimestampAfter`, `includeArtifacts`, `historyLength`) — `a2a/core.go:823-869`.
2. **Non-map data parts** — 0.3 forces a `{"value": …}` wrapper plus a `metadata.data_part_compat: true` marker for any non-object (`a2acompat/a2av0/conversions.go:369-379`). v2 carries `data` as any JSON value (`a2a/core.go:681`, `a2a/event_json_test.go:334-341` round-trips string/int/bool/float/slice).
3. **`referenceTaskIds` on messages** — v2 native (`a2a/core.go:215`); survives conversion but is unused by our 0.3 client.
4. **File parts flattened, no double-encode** — v2 `raw` (base64 in JSON) / `url` + `mediaType` + `filename` on the part itself (`a2a/core.go:585-589`, fixtures `a2a/json_test.go:55-56`), instead of 0.3's nested `file: {bytes|uri, mimeType, name}` shape that the compat layer re-wraps (`a2acompat/a2av0/conversions.go:381-402`).
5. **`tenant`** on every request type (`a2a/core.go:775, 812, 826, 874, 896`) — no 0.3 equivalent.
6. **Push-config methods with proper `scheme`** — v2 `PushAuthInfo.Scheme` (singular) vs 0.3 `Schemes[]`, where compat **drops all but the first** (`a2acompat/a2av0/conversions.go:541-543` `res.Auth.Scheme = c.Auth.Schemes[0]`).
7. **`SendMessageConfig.returnImmediately`** is a first-class bool; on 0.3 it is round-tripped through the inverted `blocking` pointer with an `!` (`a2acompat/a2av0/conversions.go:649-651`, `:673`), which loses the "unset" distinction.
8. **`Extensions.ActivatedURIs()`** — the v2 transport keeps activated-extension tracking on `CallContext` (`a2asrv/extensions.go:44-55`); v0 rewrites the header name to/from `x-a2a-extensions` (`a2acompat/a2av0/conversions.go:35-47`, `:51-62`) — on v2 the header is the unprefixed `A2A-Extensions` (`a2a/svcparams.go:23`).
9. **No lossy enum re-mapping** — 0.3 states/roles pass through `v1ToLegacyTaskState` / `coreToCompatRole` (`a2acompat/a2av0/conversions.go:65-96`), where any unmapped value silently collapses to `Unspecified` (`:113-126`).
10. **CORS on the card** is emitted by the shared v2 handler for both, so no gain there.

### Requires (v2 mandates, 0.3 did not)

1. **New method names** — `SendStreamingMessage` / `SendMessage` / `CancelTask` / `SubscribeToTask` / `GetTask` (§2). Sending `"message/stream"` to v2 → `-32601 "method not found"` (`a2asrv/jsonrpc.go:122`).
2. **`role` must be `"ROLE_USER"` / `"ROLE_AGENT"`** (`a2a/core.go:152-158`), not `"user"` / `"agent"`. Non-empty garbage passes validation and silently degrades to assistant role (`mapping/message.go:93-101`).
3. **Task states must be `TASK_STATE_*`** when the client sends them (e.g. `ListTasks.status`) — `a2a/core.go:272-292`.
4. **Parts must use the flattened keys** `text` / `data` / `raw` / `url`; there is no `kind` field and **no `file` key** (`a2a/core.go:672-716`). A 0.3 `{"kind":"file","file":{…}}` part decodes to an empty part.
5. **Client must derive `final` itself** — no `final` field exists on `statusUpdate` (§4). Use `state ∈ {COMPLETED, CANCELED, FAILED, REJECTED} ∪ {INPUT_REQUIRED}` (`a2acompat/a2av0/conversions.go:485` is the reference predicate).
6. **Stream-event discrimination by envelope key**, not by `kind` — `message` / `task` / `statusUpdate` / `artifactUpdate` (`a2a/core.go:96-107`). Missing key → the decoder rejects with `"unknown event type"` (`a2a/core.go:143`).
7. **`SendMessage` (non-streaming) result is one level deeper** — `result.{task|message}` instead of the bare object (`a2asrv/jsonrpc.go:105-110`).
8. **`configuration.blocking` is gone** — use `configuration.returnImmediately` with inverted polarity (`a2a/core.go:762`).
9. **Card parsing must read `supportedInterfaces[0].protocolVersion`** — the root `protocolVersion` / `url` / `preferredTransport` fields do not exist on v2 (`a2a/agent.go:46-89` vs `a2acompat/a2av0/agentcard.go:340-345`).
10. **`A2A-Version` header** — declared as a service param (`a2a/svcparams.go:19`) and sent by the a2a-go client (`a2aclient/client.go:260`), but `grep` shows **no server-side enforcement** in v2.1.0 (only `a2aclient` and the error tables reference it). Not required; safe to omit.

### Unchanged across the two (no client work)
Auth header (`nestor-token`), SSE framing, JSON-RPC envelope keys (`jsonrpc`/`id`/`method`/`params`/`result`/`error`), all error codes and `ToJSONRPCError` semantics, every metadata key, every `data_type` value and the `data_type`/`data_version` envelope, all ten card extension URIs and their `params` schemas, `capabilities.streaming: true`, and rate-limit signalling via the `-32029` `retryable_error` data part.

# REPORT 2 — Quota surface

All facts gathered. Writing the report.

# Nestor Quota Surface — Contract Extraction

All paths relative to `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/.references/`.

---

## 1. The quota endpoint

### 1.1 Route registration

Exactly ONE quota route exists in the whole backend:

`nestor-code-completion/service/nestor/internal/httpserver/handler.go:309-310`
```go
	// quota
	h.e.GET("/api/v1/quota", h.quotaHandler, apiLimiter)
```

`apiLimiter` is the generic per-identity rate limiter, not a quota limiter — `nestor-code-completion/service/nestor/internal/httpserver/handler.go:240`:
```go
	apiLimiter := newRateLimitMiddleware(cfg.RateLimit)
```

The route carries **no** `userLimitMiddleware` (contrast handler.go:331-332 below). Reading the quota does not consume the quota.

### 1.2 Auth

Two layers, both must be satisfied:

**(a) Global `authMiddleware`** — registered via `h.e.Use(...)`, i.e. applies to EVERY route including `/api/v1/quota` and both a2a POSTs, but only when `cfg.AuthMiddlewareEnabled` — `nestor-code-completion/service/nestor/internal/httpserver/handler.go:335-343`:
```go
func (h *Handler) applyDefaultMiddlewares(cfg Config) {
	if cfg.AuthMiddlewareEnabled {
		skipPaths := []string{"/api/v2/token/introspect", "/mcp/oauth/introspect", "/publication/ready", dpIntegrityVerifyPath}
		blockedPaths := []string{
			"/api/v2/token", "/api/v1/ide-activities/logs", "/swagger/*",
			downloadPathPrefix + "*", fliptPathPrefix + "*",
		}
		h.e.Use(authMiddleware(h.useCases.Nestor, skipPaths, blockedPaths))
	}
```
`/api/v1/quota` is in neither `skipPaths` nor `blockedPaths` → it is authenticated exactly like the a2a POST.

The header it reads is lowercase `nestor-token` — `nestor-code-completion/service/nestor/internal/httpserver/middleware.go:54-57`:
```go
			token := c.Request().Header.Get("nestor-token")
			if token == "" {
				return echo.NewHTTPError(http.StatusUnauthorized, "Empty token")
			}
```
On success it injects the identity headers (middleware.go:68-71):
```go
			req := c.Request()
			req.Header.Set("X-Preferred-Username", resp.PreferredUsername)
			req.Header.Set("X-User-Type", resp.Kind)
			req.Header.Set("X-User-Id", resp.Sub)
```
Config flag: `nestor-code-completion/service/nestor/internal/config/config.go:22` — `AuthMiddlewareEnabled bool \`env:"AUTH_MIDDLEWARE_ENABLED"  envDefault:"false"\``.

**(b) User identity in context** — the handler itself requires a non-empty user id, sourced from the `X-User-id` request header via `headersMiddleware`:

- header binding: `nestor-code-completion/service/nestor/internal/httpserver/api.go:9-19`, field `UserID string \`header:"X-User-id"\`` (api.go:14)
- context population: `nestor-code-completion/service/nestor/internal/httpserver/middleware.go:108` → `shared.ContextWithDomainContext(ctx, toDomainContext(headers))`
- extraction: `nestor-code-completion/service/nestor/internal/domain/shared/shared.go:196-206`
```go
func GetUserID(ctx context.Context) (string, error) {
	dmnCtx, err := GetDomainContext(ctx)
	if err != nil {
		return "", err
	}
	userID := dmnCtx.User.ID
	if userID == "" {
		return "", fmt.Errorf("user ID not found in context")
	}
	return userID, nil
}
```

Swagger declares both auth schemes — `nestor-code-completion/service/nestor/docs/swagger.yaml:3456-3458`:
```yaml
      security:
      - BearerAuth: []
      - ApiKeyAuth: []
```
with the scheme definitions at `nestor-code-completion/service/nestor/internal/httpserver/handler.go:224-232`: `BearerAuth` = header `Authorization`, `ApiKeyAuth` = header `nestor-token`. (Only `nestor-token` is actually read by `authMiddleware`; `Authorization` handling on this route: NOT FOUND.)

### 1.3 Handler (verbatim)

`nestor-code-completion/service/nestor/internal/httpserver/quota_handler.go:14-87`
```go
// Quota
//
//	@Summary		Get current user's LLM quotas
//	@Description	Returns a backend-calculated snapshot of all quotas applicable to the current user.
//	@Description	Usage is normalized to the [0, 1] range. Clients must use status fields and must not derive availability from usage.
//	@Description	New quota types and scopes may be added as new items without changing the response structure.
//	@Tags			quota
//	@Security		BearerAuth
//	@Security		ApiKeyAuth
//	@Produce		json,plain
//	@Success		200	{object}	QuotaResponse		"Current quotas"
//	@Failure		401	{object}	QuotaErrorResponse	"Unauthorized"
//	@Failure		500	{object}	QuotaErrorResponse	"Failed to read quota status"
//	@Router			/v1/quota [get]
func (h *Handler) quotaHandler(c echo.Context) error {
	ctx := c.Request().Context()
	userID, err := shared.GetUserID(ctx)
	if err != nil {
		return c.JSON(http.StatusUnauthorized, QuotaErrorResponse{Message: "unauthorized"})
	}

	providers := []quota.UserQuota{}
	if h.limiters.Qwen35 != nil {
		providers = append(providers, h.limiters.Qwen35)
	}
	if h.limiters.Fast != nil {
		providers = append(providers, h.limiters.Fast)
	}
	limits := make([]QuotaLimit, 0, len(providers))
	for _, provider := range providers {
		if provider == nil {
			continue
		}

		info, readErr := provider.Quota(ctx, userID)
		if errors.Is(readErr, quota.ErrNotEnabled) {
			continue
		}
		if readErr != nil {
			log.Ctx(ctx).Error().Err(readErr).Msg("failed to read quota status")
			return c.JSON(http.StatusInternalServerError, QuotaErrorResponse{Message: "failed to read quota status"})
		}
		if info != nil {
			limits = append(limits, quotaLimit(info))
		}
	}

	return c.JSON(http.StatusOK, QuotaResponse{
		SchemaVersion: "1.0",
		GeneratedAt:   h.timeProvider.Now(),
		Limits:        limits,
	})
}

func quotaLimit(info *quota.Info) QuotaLimit {
	return QuotaLimit{
		ID: info.ID,
		Display: QuotaDisplay{
			Title:       info.Title,
			Description: info.Description,
		},
		Scope: QuotaScope{
			Type:   info.Scope.Type,
			Values: info.Scope.Values,
		},
		Usage: info.Usage,
		Status: QuotaLimitStatus{
			State:    info.Status.State,
			Severity: info.Status.Severity,
			Message:  info.Status.Message,
		},
		ResetAt: info.ResetAt,
	}
}
```

### 1.4 Response structs (verbatim)

`nestor-code-completion/service/nestor/internal/httpserver/api.go:1406-1443`
```go
// QuotaResponse describes the current user's normalized quota state.
type QuotaResponse struct {
	SchemaVersion string       `json:"schema_version" example:"1.0"`
	GeneratedAt   time.Time    `json:"generated_at"`
	Limits        []QuotaLimit `json:"limits"`
}

// QuotaLimit describes one independently measured quota.
type QuotaLimit struct {
	ID      string           `json:"id" example:"agent-dynamic-budget"`
	Display QuotaDisplay     `json:"display"`
	Scope   QuotaScope       `json:"scope"`
	Usage   float64          `json:"usage" minimum:"0" maximum:"1" example:"0.83"`
	Status  QuotaLimitStatus `json:"status"`
	ResetAt *time.Time       `json:"reset_at,omitempty"`
}

type QuotaDisplay struct {
	Title       string  `json:"title" example:"Динамический бюджет"`
	Description *string `json:"description,omitempty"`
}

// QuotaScope identifies the client-visible dimension sharing the quota.
type QuotaScope struct {
	Type   string   `json:"type" example:"mode"`
	Values []string `json:"values" example:"default"`
}

// QuotaLimitStatus must be used by clients instead of deriving availability from quota values.
type QuotaLimitStatus struct {
	State    string `json:"state" enums:"allowed,warning,exhausted" example:"warning"`
	Severity string `json:"severity" enums:"info,warning,error" example:"warning"`
	Message  string `json:"message" example:"При высокой нагрузке доступ может быть ограничен."`
}

type QuotaErrorResponse struct {
	Message string `json:"message" example:"failed to read quota status"`
}
```

### 1.5 JSON keys, types, units — client-facing summary

| JSON key | Go type | Units / values |
| --- | --- | --- |
| `schema_version` | string | hardcoded `"1.0"` (quota_handler.go:62) |
| `generated_at` | RFC3339 timestamp | server now, `h.timeProvider.Now()` (quota_handler.go:63) |
| `limits[]` | array | 0..2 items (one per non-disabled limiter, quota_handler.go:36-41) |
| `limits[].id` | string | always the literal `"token-usage"` for both entries — `nestor-code-completion/service/nestor/internal/usecase/userlimit/userlimit.go:63` (`ID: "token-usage"`). The swagger example `agent-dynamic-budget` is an example only, not produced by any code path. |
| `limits[].display.title` | string | always the literal `"Бюджет использования токенов"` (userlimit.go:64) |
| `limits[].display.description` | string, omitted when nil | never set by any producer — `quota.Info.Description` is never assigned (userlimit.go:62-71) → always absent |
| `limits[].scope.type` | string | `"mode"` for both limiters — `nestor-code-completion/service/nestor/cmd/nestor/main.go:70,74` |
| `limits[].scope.values` | []string | `["default"]` for the Qwen35 limiter, `["fast"]` for the Fast limiter (main.go:71,75) |
| `limits[].usage` | float64, `[0,1]` | **normalized ratio, NOT tokens and NOT requests** — `usage := float64(used) / float64(maxPerDay)`, clamped to [0,1] (userlimit.go:54-60) |
| `limits[].status.state` | string | `"allowed"` \| `"warning"` \| `"exhausted"` (userlimit.go:83,86,89) |
| `limits[].status.severity` | string | `"info"` \| `"warning"` \| `"error"` (same lines) |
| `limits[].status.message` | string (Russian) | see §3.4 |
| `limits[].reset_at` | RFC3339 timestamp, omitted when nil | end of the current accounting window (userlimit.go:72-75 → tokenusage.go:71-73) |

**Absolute token counts are NOT exposed.** `used` and `MaxPerDay()` are computed inside `Quota()` and only their ratio is returned (userlimit.go:44-54). A client cannot render "X of Y tokens left" — only "usage 0.83" / "17% remaining". No field carries a request count.

Concrete example shapes are asserted in `nestor-code-completion/service/nestor/internal/httpserver/quota_handler_test.go:37-41` (`used: 250` of `MaxPerDay 1000` → `wantUsage: 0.25, wantState: "allowed"`; `800` → `0.8/"warning"`; `1200` → capped `1/"exhausted"`), and `quota_handler_test.go:80` asserts `"token-usage"` as the id, `:153-155` asserts both limiters returned in order `["default"]` then `["fast"]`.

---

## 2. Versioning, and the v1 vs v2 a2a limiter wiring

### 2.1 No v2 quota route

`grep -rn -a -i "quota"` over `nestor-code-completion/` finds route registration in exactly one place, `handler.go:310`. **A `/api/v2/quota` route: NOT FOUND.** The endpoint is version-pinned at v1 in its path but is entirely outside the a2a versioning scheme — it is registered in `Init` alongside `/api/v1/flags` (handler.go:307), not in `registerNessyHandlers`. Swagger lists only `/v1/quota` (`nestor-code-completion/service/nestor/docs/swagger.yaml:3434`).

### 2.2 The a2a routes — BOTH versions get the same limiter

Wiring call site — `nestor-code-completion/service/nestor/internal/httpserver/handler.go:331-332`:
```go
	h.registerNessyHandlers(traceMiddleware, userLimitMiddleware(h.limiters.Qwen35))
	h.registerAgentCoreHandlers(traceMiddleware, userLimitMiddleware(h.limiters.Qwen35))
```

Route registration for both versions — `nestor-code-completion/service/nestor/internal/httpserver/handler.go:435-449`:
```go
func (h *Handler) registerNessyHandlers(middlewares ...echo.MiddlewareFunc) {
	nessy := echo.WrapHandler(h.useCases.Nessy.GetAgentHandler())
	// Тут намеренно используется общий с Cline-агентом userPool.
	// https://jira.tcsbank.ru/browse/AIDT-5346
	codeAgentPathV1 := vibe.GetCodeAgentURL("", "v1")
	h.e.POST(codeAgentPathV1, nessy, middlewares...)
	nessyCard := echo.WrapHandler(h.useCases.Nessy.GetCardHandler())
	h.e.GET(codeAgentPathV1+a2asrv.WellKnownAgentCardPath, nessyCard)

	codeAgentPathV2 := vibe.GetCodeAgentURL("", "v2")
	nessyV2 := echo.WrapHandler(h.useCases.Nessy.GetAgentHandlerV2())
	h.e.POST(codeAgentPathV2, nessyV2, middlewares...)
	nessyCardV2 := echo.WrapHandler(h.useCases.Nessy.GetCardHandlerV2())
	h.e.GET(codeAgentPathV2+a2asrv.WellKnownAgentCardPath, nessyCardV2)
}
```

Path construction — `nestor-code-completion/service/nestor/internal/usecase/vibe/usecase_nessy.go:74-83`:
```go
func GetCodeAgentURL(baseURL string, version string) string {
	baseURL = strings.TrimSuffix(baseURL, "/")

	return baseURL + "/" + path.Join(
		"api",
		version,
		"code-agent",
		"a2a",
	)
}
```
→ `/api/v1/code-agent/a2a` and `/api/v2/code-agent/a2a`.

**Answer: YES — identical.** The same `middlewares...` slice (containing `userLimitMiddleware(h.limiters.Qwen35)`) is spread onto the POST of BOTH `codeAgentPathV1` (handler.go:440) and `codeAgentPathV2` (handler.go:446). The two agent-card GETs (handler.go:442, :448) get NO middleware at all — the card is unlimited and unmetered.

Note only v1 has a swagger entry (`docs/swagger.yaml:2950` `/v1/code-agent/a2a`; the annotation block at handler.go:421-434 documents v1 only). A swagger entry for `/v2/code-agent/a2a`: NOT FOUND — but the route exists in code.

### 2.3 The agentcore agents routes also share the limiter

`nestor-code-completion/service/nestor/internal/agentcore/agents/echo_adapter.go:58-71`:
```go
func (a *EchoAdapter) Register(e *echo.Echo, middlewares EchoMiddlewares) {
	cardMiddlewares := []echo.MiddlewareFunc{}
	cardMiddlewares = append(cardMiddlewares, middlewares.Infrastructure...)

	invokeMiddlewares := []echo.MiddlewareFunc{}
	invokeMiddlewares = append(invokeMiddlewares, middlewares.Infrastructure...)
	invokeMiddlewares = append(invokeMiddlewares, middlewares.UserPool)

	// TODO: переехать на v2 в ahui и не мучаться с поддержкой старой версии
	e.GET("/api/agents/:"+agentNameParameter+"/a2a/v1"+a2asrv.WellKnownAgentCardPath, a.agentCardV1, cardMiddlewares...)
	e.GET("/api/agents/:"+agentNameParameter+"/a2a/v2"+a2asrv.WellKnownAgentCardPath, a.agentCardV2, cardMiddlewares...)

	e.POST("/api/agents/:"+agentNameParameter+"/a2a/v1"+executePath, a.invokeAgentV1, invokeMiddlewares...)
	e.POST("/api/agents/:"+agentNameParameter+"/a2a/v2"+executePath, a.invokeAgentV2, invokeMiddlewares...)
```
Same pattern: `UserPool` (= the Qwen35 limiter) on both v1 and v2 POST, none on the cards.

### 2.4 Other paths that consume the same limiter (not via middleware)

- CLI gateway proxy — checked in-handler, per model: `nestor-code-completion/service/nestor/internal/httpserver/cli_proxy_handler.go:109` and `:205` call `h.acquireCLILimiter(c, req.Model)`; selection at `cli_proxy_handler.go:286-298` maps `m.UserPool == "qwen35"` → `h.limiters.Qwen35`, `"fast"` → `h.limiters.Fast`; `acquireCLILimiter` (`:300-307`) delegates to the same `checkUserLimit`. Note `registerCLIHandlers` (handler.go:398-411) attaches NO `userLimitMiddleware` — the check is inside the handler.
- LLM proxy — `nestor-code-completion/service/nestor/internal/httpserver/llm_proxy_handler.go:112-131`, limiter applied only when `model == h.cfg.AgentMode.Model`.

---

## 3. What the limiter counts, where limits come from, and the 429 bodies

### 3.1 Two independent gates

`nestor-code-completion/service/nestor/internal/usecase/userlimit/userlimit.go:1-6` (package doc):
```go
// Package userlimit решает, пускать ли пользователя к инференсу.
//
// Решение складывается из двух независимых источников: заполненности пула активных
// сессий (usecase/userpool) и суточного расхода токенов пользователем
// (usecase/tokenusage). Пока пул свободен, токены не проверяются вовсе — лимит нужен
// только чтобы под нагрузкой самые «тяжёлые» пользователи уступали место остальным.
```

`Allow` (userlimit.go:131-183): if the pool is below `softLimitRatio` occupancy the token counter is **not consulted at all** (`:146-148`); the daily token limit only bites when the pool is loaded (`:172-180`).

### 3.2 What is counted — weighted tokens per day, per pool group (NOT per model)

`nestor-code-completion/service/nestor/internal/usecase/tokenusage/tokenusage.go:1-6`:
```go
// Package tokenusage хранит суточный расход токенов по пользователям.
//
// Счётчик живёт в Redis как HASH: один ключ на группу на сутки, поле — идентификатор
// пользователя. Обнуления по расписанию нет: дата входит в имя ключа, а сам ключ живёт
// до resetTimeOffset следующего дня, поэтому счёт начинается заново в resetTimeOffset.
```

Weights — `tokenusage.go:20-28`:
```go
const (
	dateLayout      = "2006-01-02"
	resetTimeOffset = 11 * time.Hour

	// Коэффициенты для расчёта использованных токенов.
	inputPrice      = 1.0
	cachedPrice     = 0.1
	completionPrice = 4.0
)
```

Three counters per user per day, keyed `<userID>:new_input`, `<userID>:cached`, `<userID>:completion` — `tokenusage.go:105-111`; `new_input = promptTokens - cachedTokens` (`tokenusage.go:88`).

The scalar that is compared against the limit — `tokenusage.go:151`:
```go
	return int64(float64(newInput)*inputPrice + float64(cached)*cachedPrice + float64(completion)*completionPrice), nil
```
So the unit is a **weighted token count**, not raw tokens: a completion token costs 4×, a cache-hit input token 0.1×.

Redis key = per **pool group**, not per model — `tokenusage.go:158-160`:
```go
func (s *Storage) usageKey(now time.Time) string {
	return fmt.Sprintf("%s_token_usage_%s", s.group, now.Add(-resetTimeOffset).Format(dateLayout))
}
```
Two groups exist in prod: `qwen35` and `fast` (see §3.3). All models mapped to a group share one budget.

Recording is done by a callback attached to the streaming response — `nestor-code-completion/service/nestor/internal/httpserver/userlimit_middleware.go:36-48`:
```go
func makeTokenRecorder(ctx context.Context, limiter *userlimit.Limiter) openai.RecordTokens {
	if limiter == nil {
		return nil
	}

	// Стрим дочитывается уже после того, как хендлер вернул ответ, поэтому запоминаем
	// контекст без отмены: значения (в том числе пользователь) в нём остаются.
	recordCtx := context.WithoutCancel(ctx)

	return func(promptTokens, completionTokens, cachedTokens int64) {
		limiter.Record(recordCtx, promptTokens, completionTokens, cachedTokens)
	}
}
```

### 3.3 Where the limit values come from

Config struct — `nestor-code-completion/service/nestor/internal/config/config.go:159-177`:
```go
type ActiveUserPool struct {
	Enabled  bool          `env:"ENABLED" envDefault:"false"`
	MaxUsers int64         `env:"MAX_USERS" envDefault:"100"`
	TTL      time.Duration `env:"TTL" envDefault:"2m"`
	Group    string        `env:"GROUP" envDefault:"agent"`
	// SoftLimitRatio — доля заполненности пула, ниже которой запрос пропускается без проверки токенов.
	SoftLimitRatio float64    `env:"SOFT_LIMIT_RATIO" envDefault:"0.9"`
	Tokens         TokenUsage `envPrefix:"TOKENS_"`
}

// TokenUsage — суточный лимит токенов на пользователя. Применяется только когда пул
// заполнен более чем на ActiveUserPool.SoftLimitRatio.
type TokenUsage struct {
	Enabled bool `env:"ENABLED" envDefault:"false"`
	// MaxPerDay — сколько токенов пользователь может потратить за сутки. 0 — без лимита.
	MaxPerDay int64 `env:"MAX_PER_DAY" envDefault:"0"`
	// ResetLocation — таймзона, в которой наступает 00:00 и обнуляется счётчик.
	ResetLocation string `env:"RESET_LOCATION" envDefault:"Europe/Moscow"`
}
```

Env prefixes — `nestor-code-completion/service/nestor/internal/config/config.go:57-58`:
```go
	CommonUserPool             ActiveUserPool   `envPrefix:"AGENT_USER_POOL_"`
	CLIFastUserPool            ActiveUserPool   `envPrefix:"CLI_FAST_USER_POOL_"`
```
→ full env var names `AGENT_USER_POOL_TOKENS_ENABLED`, `AGENT_USER_POOL_TOKENS_MAX_PER_DAY`, `AGENT_USER_POOL_TOKENS_RESET_LOCATION`, and the `CLI_FAST_USER_POOL_TOKENS_*` triple. Confirmed in the deployment template — `nestor-code-completion/service/nestor/helm/nestor/templates/deployment.yaml:216-221` and `:234-239`.

Construction — `nestor-code-completion/service/nestor/cmd/nestor/main.go:68-77`:
```go
	limiters := httpserver.Limiters{
		Qwen35: makeLimiter(cfg.CommonUserPool, redisClient, timeProvider, userlimit.Scope{
			Type:   "mode",
			Values: []string{"default"},
		}),
		Fast: makeLimiter(cfg.CLIFastUserPool, redisClient, timeProvider, userlimit.Scope{
			Type:   "mode",
			Values: []string{"fast"},
		}),
	}
```
and `main.go:199-220` (`makeLimiter` → `tokenusage.New(cfg.Group, cfg.Tokens, ...)`, `userlimit.New(userpool.New(cfg, redisClient), usage, cfg.SoftLimitRatio, cfg.Group, scope)`).

Limiters container — `nestor-code-completion/service/nestor/internal/httpserver/handler.go:103-108`:
```go
// Limiters — по одному лимитеру на пул моделей. Лимитер решает, пускать ли
// пользователя, по заполненности пула сессий и его суточному расходу токенов.
type Limiters struct {
	Qwen35 *userlimit.Limiter
	Fast   *userlimit.Limiter
}
```

**Actual production values** — `nestor-code-completion/service/nestor/helm/nestor/values.ya-a-prod1.yaml:58-78`:
```yaml
# Agent configuration
agent:
  user_pool_enabled: "true"
  user_pool_max_users: "360"
  user_pool_ttl: "2m"
  user_pool_group: "qwen35"
  user_pool_soft_limit_ratio: "0.9"
  user_pool_tokens_enabled: "true"
  user_pool_tokens_max_per_day: "8000000"
  user_pool_tokens_reset_location: "Europe/Moscow"

# CLI Fast user pool (tgpt/qwen36-35b-a3b-fp8)
cli_fast:
  user_pool_enabled: "true"
  user_pool_max_users: "100"
  user_pool_ttl: "2m"
  user_pool_group: "fast"
  user_pool_soft_limit_ratio: "0.9"
  user_pool_tokens_enabled: "false"
  user_pool_tokens_max_per_day: "0"
  user_pool_tokens_reset_location: "Europe/Moscow"
```
Consequence for a client: **on `ya-a-prod1` the `/api/v1/quota` response contains exactly ONE limit** — `scope.values: ["default"]` with `MaxPerDay = 8000000` weighted tokens/day; the `fast` limiter is skipped because `usage.Enabled()` is false → `quota.ErrNotEnabled` → `continue` (quota_handler.go:49-51, userlimit.go:41-43). Dev values are both disabled — `nestor-code-completion/service/nestor/helm/nestor/values.ya-ruc1-dev1.yaml:63-64` and `:74-75` (`user_pool_tokens_enabled: "false"`, `max_per_day: "0"`) → `limits: []`.

### 3.4 Status thresholds and messages (verbatim)

`nestor-code-completion/service/nestor/internal/usecase/userlimit/userlimit.go:20` — `const quotaWarningThreshold = 0.8`

`nestor-code-completion/service/nestor/internal/usecase/userlimit/userlimit.go:80-92`:
```go
func (l *Limiter) quotaStatus(usage float64) quota.Status {
	switch {
	case usage >= 1:
		return quota.Status{State: "exhausted", Severity: "error",
			Message: "Бюджет использования токенов исчерпан. При высокой нагрузке доступ будет ограничен."}
	case usage >= quotaWarningThreshold:
		return quota.Status{State: "warning", Severity: "warning",
			Message: "Квота близка к исчерпанию. Возможны ограничения при высокой нагрузке"}
	default:
		return quota.Status{State: "allowed", Severity: "info",
			Message: "Запросы доступны. Возможны ограничения при высокой нагрузке"}
	}
}
```
(Note the deliberate hedging: even `exhausted` says access is restricted only under load — matching §3.1.)

### 3.5 The exact 429 body strings

`nestor-code-completion/service/nestor/internal/httpserver/userlimit_middleware.go:15-20`:
```go
const (
	msgTooManyRequests = "too many requests"
	// msgTokenLimitExceeded адресован конкретному пользователю: ждать освобождения
	// пула ему бессмысленно, лимит обновится в 00:00.
	msgTokenLimitExceeded = "суточный лимит токенов исчерпан, лимит обновится в 00:00"
)
```
Emission — `userlimit_middleware.go:54-71`:
```go
func checkUserLimit(ctx context.Context, limiter *userlimit.Limiter) error {
	if limiter == nil {
		return nil
	}

	err := limiter.Allow(ctx)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, userlimit.ErrPoolFull):
		return echo.NewHTTPError(http.StatusTooManyRequests, msgTooManyRequests)
	case errors.Is(err, userlimit.ErrTokenLimitExceeded):
		return echo.NewHTTPError(http.StatusTooManyRequests, msgTokenLimitExceeded)
	default:
		log.Ctx(ctx).Warn().Err(err).Msg("user limit check failed, skipping")
		return nil
	}
}
```
Underlying sentinels — `nestor-code-completion/service/nestor/internal/usecase/userlimit/errors.go:9-15`: `ErrPoolFull = userpool.ErrPoolFull`; `ErrTokenLimitExceeded = fmt.Errorf("daily token limit exceeded")`.

No custom `HTTPErrorHandler` is registered anywhere in `service/` or `pkg/` (grep for `HTTPErrorHandler`: zero hits) → echo's default serialization applies, i.e. the wire body is `{"message":"суточный лимит токенов исчерпан, лимит обновится в 00:00"}` / `{"message":"too many requests"}`. (The `{"message": …}` envelope is echo framework behavior, not a repo-cited literal.)

Two other, distinct 429 bodies exist on adjacent paths — do NOT conflate them with the quota limiter:
- generic rate limiter deny — plain-text `"rate limit exceeded"` plus a `Retry-After` header: `nestor-code-completion/service/nestor/internal/httpserver/middleware.go:171-175`.
- agent-overload flag — `nestor-code-completion/service/nestor/internal/httpserver/llm_proxy_handler.go:143-150`, body `{"error":{"message":"Ведутся технические работы, агентский режим временно недоступен всем или части пользователей"}}` at 429.

### 3.6 `reset_at` semantics — and a discrepancy worth flagging

`nestor-code-completion/service/nestor/internal/usecase/userlimit/userlimit.go:35-37, 72-75`:
```go
type tokenUsageReset interface {
	ResetAt() time.Time
}
	if reset, ok := l.usage.(tokenUsageReset); ok {
		resetAt := reset.ResetAt()
		info.ResetAt = &resetAt
	}
```
`nestor-code-completion/service/nestor/internal/usecase/tokenusage/tokenusage.go:70-73, 162-165`:
```go
// ResetAt returns the end of the current accounting window.
func (s *Storage) ResetAt() time.Time {
	return s.expiresAt(s.now())
}
// expiresAt — resetTimeOffset следующего дня в таймзоне сброса.
func (s *Storage) expiresAt(now time.Time) time.Time {
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, s.location).AddDate(0, 0, 1).Add(resetTimeOffset)
}
```
So `reset_at` = **tomorrow 11:00 in `ResetLocation` (Europe/Moscow)**, because `resetTimeOffset = 11 * time.Hour` (tokenusage.go:22). Three consequences a client UI must not get wrong:

1. The window boundary is **11:00 Moscow, not midnight**, despite the 429 string promising `лимит обновится в 00:00` (userlimit_middleware.go:19) and the config comment `таймзона, в которой наступает 00:00` (config.go:175). The user-facing 429 string and the actual reset time disagree; `reset_at` is the authoritative value.
2. The counter key rolls at 11:00 (`now.Add(-resetTimeOffset)` in `usageKey`, tokenusage.go:159) while `expiresAt` is computed from *today's* calendar date + 1 day + 11h. For a request served before 11:00 local, the key still belongs to yesterday's date but `reset_at` reports tomorrow 11:00 — i.e. `reset_at` overshoots the real rollover by ~24h in the 00:00–11:00 window. Flagged as an observation from the two cited functions; no test in the repo pins this case (`tokenusage_test.go` was not read for this claim — treat as inferred-from-code, not test-confirmed).
3. `reset_at` is only present when the concrete `*tokenusage.Storage` is behind the interface (userlimit.go:72). A mock/alternate `TokenUsage` implementation yields no `reset_at` → the field is omitted. Clients must handle its absence.

---

## 4. Does the connector or the docs use the quota endpoint?

**Reference connector — NO. NOT FOUND.**
`grep -rn -a -i "quota"` over `nestor-assistant/nessy-acp-agent` (excluding `node_modules`) returns **0 matches**. The connector has no notion of quota, no `/api/v1/quota` call, no `token-usage` id handling.

What the connector *does* have is generic 429 retry, which is a different surface entirely:
- `nestor-assistant/nessy-acp-agent/src/adapter/a2a/a2a-retry-manager.ts:11` — `export const RATE_LIMIT_ERROR_CODES: ReadonlySet<number> = new Set([429, -32029]);`
- `nestor-assistant/nessy-acp-agent/src/adapter/a2a/a2a-errors.ts:86-87` — `// HTTP 429 + JSON-RPC -32029 — rate-limit; -32001 — task not found (тоже стоит ретраить).` / `const RETRYABLE_STREAM_ERROR_CODES: ReadonlySet<number> = new Set([429, -32029, -32001]);`
- `nestor-assistant/nessy-acp-agent/src/errors/index.ts:99` — `if (code === 429 || code === -32029) return 'A2A_RATE_LIMIT';`
- `nestor-assistant/nessy-acp-agent/src/core/agent/installer/helper/http-retry.ts:2` — `return status === 429 || status >= 500;`

So the connector treats a quota-exhaustion 429 as an anonymous retryable rate-limit and retries it, without reading the message or the quota endpoint.

**Docs — NO. NOT FOUND.**
`grep -rn -a -i` over `nestor-assistant/docs/nessy-cloud` (13 files: `architecture.md`, `index.md`, `a2a-sdk/{usage,faq,index,types}.md`, `chat-component/{cdn,imperativeApi,connection,backend,index,propsDescr}.md`, `cli/index.md`) returns **0 matches** for `quota`, **0** for `limit`/`лимит`, **0** for `429`. The docs do not describe quota at all — there is nothing to quote.

**agentcore — NO. NOT FOUND.** `grep -rn -a -i "quota" pkg/agentcore` → 0 matches. agentcore has no quota concept; its only limit-adjacent artifact is the retryable-error extension (§5).

---

## 5. Other user-limit surfaces a client could read

### 5.1 Present

| Surface | Status | Citation |
| --- | --- | --- |
| `GET /api/v1/quota` JSON | **PRESENT** — the only structured quota surface | handler.go:310 |
| 429 + body `{"message":"суточный лимит токенов исчерпан, лимит обновится в 00:00"}` on inference calls | **PRESENT** — the only *reactive* signal that the daily token budget is gone; distinguishable from pool-full by the message string alone | userlimit_middleware.go:19,66 |
| `Retry-After` response header | **PRESENT but unrelated to quota** — set only by the generic per-identity rate limiter's deny handler, value = `cfg.Interval.String()` | middleware.go:173 |
| A2A `retryable_error` DataPart | **PRESENT but carries no quota data** — a rate-limit event is flattened to `{code: -32029, message: "Inference rate limit error occurred, please try again later"}`; no usage, no reset, no budget | `nestor-code-completion/pkg/agentcore/a2a/extensions/retryable_error_extension.go:20-28, 57-61`; extension URI `"urn:a2a:extension:retryable-error:v1"` at `:37` |

Verbatim, the only limit-bearing a2a data structure:
```go
type ErrorData struct {
	Code    int    `json:"code" mapstructure:"code" validate:"required"`
	Message string `json:"message" mapstructure:"message" validate:"required"`
}

type RetryableErrorV1 struct {
	ID    string    `json:"id" mapstructure:"id" validate:"required"`
	Error ErrorData `json:"error" mapstructure:"error" validate:"required"`
}
```
(`retryable_error_extension.go:20-28`)

### 5.2 Explicitly NOT FOUND

- **Quota/usage/limit response headers on any route.** The only `Header().Set` calls in the http layer are `middleware.go:69-71` (`X-Preferred-Username`, `X-User-Type`, `X-User-Id` — set on the *inbound* request, not the response) and `middleware.go:173` (`Retry-After`, generic rate limiter only). No `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-Quota-*`, or equivalent exists. **NOT FOUND.**
- **A quota field, extension, or capability on the agent card.** The full extension list built for the card is at `nestor-code-completion/service/nestor/internal/usecase/vibe/usecase_nessy.go:104-163` — `toolDataExtension`, `environmentDataExtension`, `agentSettingsExtension`, `agentsMdExtension`, `retryableErrorExtension`, `skillsExtension`, `workspaceTabsExtension`, `requestDetailsExtension`, `reasoningDataExtension`, `docSearchResultDataExtension`. The card body (`usecase_nessy.go:165-189`) carries `Name`, `Description`, `Skills`, `Capabilities{Streaming, Extensions}`, `DefaultInputModes`, `DefaultOutputModes`, `SupportedInterfaces` — no quota, no limits, no budget. **NOT FOUND.**
- **A quota-bearing A2A DataPart.** No extension in `pkg/agentcore/a2a/extensions/` (17 files listed; `agents_md_*`, `data_part.go`, `mapstructure.go`, `metadata.go`, `reasoning_data_*`, `retryable_error_*`, `server_tool_invocation.go`, `server_tool_status.go`, `tool_call.go`, `tool_data_*`, `tool_mcp.go`, `tool_result.go`, `versioned.go`) mentions quota — `grep -rn -a -i "quota" pkg/agentcore` = 0 hits. **NOT FOUND.**
- **Absolute remaining-token count anywhere on the wire.** `MaxPerDay()` and `Used()` never leave the server; only their clamped ratio does (userlimit.go:44-60). **NOT FOUND.**
- **A per-model quota breakdown.** The scope is `{"type":"mode","values":["default"]}` / `["fast"]` (main.go:69-76) — a pool group, not a model id. There is no field naming a model. **NOT FOUND.**
- **A request-count or session-slot number exposed to clients.** `userpool.Stat{Current, Max, UserInPool}` is read internally (userlimit.go:138-151) and never serialized to any response. **NOT FOUND.**
- **`/api/v2/quota` or any versionless `/quota`.** **NOT FOUND** (§2.1).
- **Push/streamed quota updates.** No SSE/websocket quota channel exists; the endpoint is poll-only GET. **NOT FOUND.**

### 5.3 Practical client recipe

1. `GET https://code-completion-nestor.tcsbank.ru/api/v1/quota` with header `Nestor-Token: <JWT>` (header lookup is case-insensitive per Go's `Header.Get`; the code writes `"nestor-token"`, middleware.go:54).
2. Parse `limits[]`; select by `scope.values` (`"default"` = the main coder pool, `"fast"` = the fast pool). Expect 1 entry on prod, 0 on dev.
3. Render `1 - usage` as "remaining", and `reset_at` as the refresh time — but drive any enabled/disabled UI state off `status.state` / `status.severity`, never off `usage`. The handler doc mandates this explicitly (quota_handler.go:18): "Clients must use status fields and must not derive availability from usage."
4. Treat `limits: []` as "no quota applies", not as "quota exhausted" — that is what a disabled limiter produces (quota_handler.go:49-51).
5. Do not display an absolute token budget; the backend does not send one.

# REPORT 3 — nessy-desktop intersection map

> **Correction (2026-08-22, measured during T17 execution):** Route B below ("everything else falls through as a BARE message to `chatImpl`, where each backend re-parses") is FALSE for Pi — `runSessionCommand` narrows the session-command union BY ELIMINATION down to `subtask`, so widening the union breaks `command.task` at `pi-agent.ts:7250,7256` and `typecheck:shared` goes red until that backend claims the new kind. Adding a kind is NOT a `base-agent.ts`-only edit; size the file list accordingly.

I have the full map. Writing up.

# Shared-code intersection map: Nestor Cloud additions 1 & 2

**Module boundary used throughout:** IN-module = `packages/shared/src/agent/backend/nestor-cloud/**` + `packages/shared/src/agent/nestor-cloud-agent.ts`. Everything below is OUTSIDE unless marked.

---

## ADDITION 1 — v2 A2A (`/api/v2/code-agent/a2a`) as the default wire

### (a) Where the URL constants live, and who imports them

**File: `packages/shared/src/agent/backend/internal/drivers/nestor-cloud.ts` — OUTSIDE the module directory.** It is the provider-driver layer (`backend/internal/drivers/`), sibling to `anthropic.ts`, `codex.ts`, `pi.ts`.

Verbatim, the whole file is 22 lines:

```
packages/shared/src/agent/backend/internal/drivers/nestor-cloud.ts:3-7
export const NESTOR_CLOUD_AGENT_CARD_URL =
  'https://code-completion-nestor.tcsbank.ru/api/v1/code-agent/a2a/.well-known/agent-card.json';

export const NESTOR_CLOUD_A2A_URL =
  'https://code-completion-nestor.tcsbank.ru/api/v1/code-agent/a2a';
```

**Full importer list of the two constants (repo-wide, `grep -a`, excluding `.references`/`node_modules`) — exactly one non-test importer, and it is IN-module:**

| Importer | Path:line | In/out of module |
| --- | --- | --- |
| `client.ts` (re-exports both under `DEFAULT_*` names) | `packages/shared/src/agent/backend/nestor-cloud/client.ts:3-5`, `:37-38` | IN |
| `client.test.ts` | `packages/shared/src/agent/backend/nestor-cloud/__tests__/client.test.ts:7-8` | IN |
| `nestor-cloud-e2e.test.ts` | `packages/shared/src/agent/__tests__/nestor-cloud-e2e.test.ts:12-13` | **OUT** |

The re-export seam, verbatim:
```
packages/shared/src/agent/backend/nestor-cloud/client.ts:37-38
export const DEFAULT_NESTOR_CLOUD_AGENT_CARD_URL = NESTOR_CLOUD_AGENT_CARD_URL;
export const DEFAULT_NESTOR_CLOUD_A2A_URL = NESTOR_CLOUD_A2A_URL;
```

**Who imports the driver object** (separate from the constants):
- `packages/shared/src/agent/backend/factory.ts:73` — `import { nestorCloudDriver } from './internal/drivers/nestor-cloud.ts';`
- `packages/shared/src/agent/backend/factory.ts:79` — `'nestor-cloud-agent': nestorCloudDriver,` (the driver registry).

**Net for (a): changing the two literals in `drivers/nestor-cloud.ts` propagates to everything except three test files and one hard-coded duplicate (see c).** No `apps/electron`, `packages/server-core`, or `apps/cli` file references either constant.

---

### (b) Runtime resolution of `baseUrl` / `agentCardUrl` — **NOT persisted, resolved from the constant on every launch**

**Chain, in order:**

1. `getBackendRuntime(this.config)` is a plain accessor — no resolution happens here:
```
packages/shared/src/agent/backend/internal/driver-types.ts:121-123
export function getBackendRuntime(config: BackendConfig): BackendRuntimePayload {
  return (config.runtime ?? {}) as BackendRuntimePayload;
}
```

2. `config.runtime` is produced by the driver's `buildRuntime`:
```
packages/shared/src/agent/backend/internal/drivers/nestor-cloud.ts:12-17
  buildRuntime: ({ context }) => ({
    baseUrl: context.connection?.baseUrl ?? NESTOR_CLOUD_A2A_URL,
    agentCardUrl: context.connection?.baseUrl
      ? `${context.connection.baseUrl.replace(/\/$/, '')}/.well-known/agent-card.json`
      : NESTOR_CLOUD_AGENT_CARD_URL,
  }),
```

3. Consumed in-module at two sites: `packages/shared/src/agent/nestor-cloud-agent.ts:69-70` (`const postUrl = typeof runtime.baseUrl === 'string' ? runtime.baseUrl : undefined;`) and `:267-271` (`createClient()` passing `postUrl` + `agentCardUrl`).

**Typing note:** `baseUrl?: string` IS declared on `BackendRuntimePayload` (`driver-types.ts:30`), but **`agentCardUrl` is NOT a declared field** — it rides the `extends Record<string, unknown>` escape hatch (`driver-types.ts:26`). That is why both read sites use `typeof … === 'string'` guards. Adding a typed field is optional but the untyped path works today.

#### CRITICAL — is the URL persisted per connection?

**No. A `nessy-cloud-agent` connection never gets a `baseUrl` written to config.** Three independent facts:

**Fact 1 — the built-in template carries no URL.** The `nessy-cloud-agent` template is three fields:
```
packages/server-core/src/domain/connection-setup-logic.ts:215-219
  'nessy-cloud-agent': {
    name: 'Nessy Cloud Agent',
    providerType: 'nestor-cloud-agent',
    authType: 'none',
  },
```
And `createBuiltInConnection` uses its `baseUrl` argument **only** to compute `hasCustomEndpoint` for the `providerType`/`authType`/`name` function-form templates — the returned object literal has **no `baseUrl` key at all**:
```
packages/server-core/src/domain/connection-setup-logic.ts:311  const hasCustomEndpoint = !!baseUrl
packages/server-core/src/domain/connection-setup-logic.ts:328-339
  return {
    slug, name, providerType, authType,
    models: getDefaultModelsForConnection(providerType, template.piAuthProvider),
    defaultModel: getDefaultModelForConnection(providerType, template.piAuthProvider),
    modelSelectionMode: providerType === 'pi' ? 'automaticallySyncedFromProvider' : undefined,
    piAuthProvider: template.piAuthProvider,
    midStreamBehavior: defaultMidStreamBehavior(providerType),
    createdAt: Date.now(),
  }
```

**Fact 2 — the card that creates it sends no `baseUrl`.** The one-click Cloud card's setup payload is a single field:
```
apps/electron/src/renderer/components/apisetup/gateway-one-click.ts:73-77
  if (kind === 'cloud') {
    return {
      slug: NESTOR_CLOUD_AGENT_SLUG,
    }
  }
```
(`NESTOR_CLOUD_AGENT_SLUG = 'nessy-cloud-agent'`, `gateway-one-click.ts:37`.) Contrast the codex/claude arm at `:65-71`, which does send `baseUrl: defaults.baseUrl`.

**Fact 3 — the setup RPC's `baseUrl` write is gated on the field being present.**
```
packages/server-core/src/handlers/rpc/llm-connections.ts:68   connection = createBuiltInConnection(setup.slug, setup.baseUrl)
packages/server-core/src/handlers/rpc/llm-connections.ts:74-75
      if (setup.baseUrl !== undefined) {
        updates.baseUrl = setup.baseUrl?.trim() || undefined
```
With `setup.baseUrl === undefined`, `updates.baseUrl` is never assigned, and the persistence merge preserves the (absent) existing value:
```
packages/shared/src/config/storage.ts:2625
    baseUrl: updates.baseUrl !== undefined ? updates.baseUrl : existing.baseUrl,
```
(`LlmConnection.baseUrl?: string` is declared at `packages/shared/src/config/llm-connections.ts:171` — `/** Custom base URL (required for *_compat providers, optional override for others) */`. Note the `LlmConnection` *interface* lives in `llm-connections.ts`; the *merge* lives in `storage.ts`.)

**Conclusion for (b): changing the constant in `drivers/nestor-cloud.ts` immediately moves every existing user to v2 on next launch. No migration is needed for the connection record. There is no v1-URL stickiness.** The only way a stored `baseUrl` reaches this driver is a hand-edited config or a non-card setup call — `drivers/nestor-cloud.ts:13-17` honours it and derives the card URL from it, which remains correct behaviour under v2.

---

### (c) Every file mentioning the literal `code-agent/a2a` (repo-wide `grep -ar`, excluding `.references`, `node_modules`, `.git`)

| File:line | Content | In/out |
| --- | --- | --- |
| `packages/shared/src/agent/backend/internal/drivers/nestor-cloud.ts:4` | agent-card URL (`/api/v1/code-agent/a2a/.well-known/agent-card.json`) | **OUT** |
| `packages/shared/src/agent/backend/internal/drivers/nestor-cloud.ts:7` | A2A post URL (`/api/v1/code-agent/a2a`) | **OUT** |
| `packages/shared/src/agent/nestor-cloud-agent.ts:330` | context-store default endpoint | IN |
| `packages/shared/src/agent/backend/nestor-cloud/__tests__/context-store.test.ts:17` | `endpoint: '…/api/v1/code-agent/a2a'` | IN |
| `packages/shared/src/agent/backend/nestor-cloud/__tests__/local-tool-adapter.test.ts:31` | `const A2A_URL = 'https://nestor-cloud.invalid/api/v1/code-agent/a2a'` (fake host) | IN |
| `packages/shared/src/agent/backend/nestor-cloud/__tests__/client.test.ts:88, :92` | already asserts **`/api/v2/code-agent/a2a`** as a `postUrl` override case | IN |
| `docs/superpowers/plans/2026-08-22-nestor-cloud-contract-fix.md:407` | F14 deferral row | doc |
| `docs/superpowers/specs/2026-08-22-nestor-remote-agent-gap-analysis.md:62, :207` | gap analysis | doc |

**Only ONE production file outside the module holds the literal: `drivers/nestor-cloud.ts` (two occurrences).**

#### The `nestor-cloud-agent.ts:330` duplicate and the sidecar

```
packages/shared/src/agent/nestor-cloud-agent.ts:326-336
  private createContextStore(postUrl?: string, sessionPath = this.getSessionStoragePath()): NestorCloudContextStore | null {
    if (!sessionPath) return null;
    return new NestorCloudContextStore({
      sessionPath,
      endpoint: postUrl ?? 'https://code-completion-nestor.tcsbank.ru/api/v1/code-agent/a2a',
      …
```
This fallback is **unreachable in practice** — the caller at `nestor-cloud-agent.ts:73` passes `postUrl` derived from `runtime.baseUrl` (`:70`), which the driver always fills (`drivers/nestor-cloud.ts:13` has its own `??` default). It is a second copy of the same default, so it must be changed in lockstep or it becomes a live v1 fallback. **This file is IN-module**, so it is not shared-code work — but it is the third literal.

#### What happens to existing sidecars when `endpoint` changes

The sidecar is `<sessionPath>/meta/nestor-cloud-context.json` (`context-store.ts:45`). Its binding check:
```
packages/shared/src/agent/backend/nestor-cloud/context-store.ts:112-119
  private matchesBindings(state: NestorCloudContextSidecar): boolean {
    return state.version === 1
      && state.provider === 'nestor-cloud-agent'
      && state.endpoint === this.bindings.endpoint
      && state.connectionSlug === this.bindings.connectionSlug
      && state.workspaceRootPath === this.bindings.workspaceRootPath
      && state.workingDirectory === this.bindings.workingDirectory
      && state.authUserId === (this.bindings.authUserId ? hashAuthUserId(this.bindings.authUserId) : undefined);
  }
```
On mismatch, `load()` returns `null` and nulls in-memory state — **no throw, no delete**:
```
packages/shared/src/agent/backend/nestor-cloud/context-store.ts:57-60
      if (!this.matchesBindings(parsed)) {
        this.state = null;
        return null;
      }
```
The next `update()` then builds a fresh record via `createEmpty()` (`:74`, `:99-110`) stamped with the NEW `endpoint`, and `write()` overwrites the file (`:122-125`).

**Consequence:** every existing session's stored `contextId` and `activeTaskId` are silently discarded on the first turn after the endpoint changes. The agent starts a fresh remote context.

**Is that acceptable?** For a v1→v2 change, **yes, and it is the correct behaviour, not a defect**: a `contextId` minted by the 0.3 handler is not a valid handle on the 1.0 handler (the gap analysis records these as two distinct server-side handlers, `docs/superpowers/specs/2026-08-22-nestor-remote-agent-gap-analysis.md:207`). Carrying it over would send a stale id to a server that does not know it. The one visible cost: any in-flight `activeTaskId` becomes unaddressable — `cancelTask` for that task can no longer be issued from this client. **No migration code is needed; the binding check is already the migration.** What is arguably owed is a user-facing note in the release notes, not a code path.

---

### (d) Tests / fixtures / docs OUTSIDE the module that pin v1 or the 0.3 wire

**1. `packages/shared/src/agent/__tests__/nestor-cloud-e2e.test.ts` — pins v1 in six places.** Live-gated (`shouldRunLive = process.env.NESSY_NESTOR_CLOUD_E2E === '1' && !!getValidCreds()?.jwt`, `:324`), so it is `describe.skip` by default — it will not fail CI, but it is wrong after the change:
- `:37` — `FixtureClient.loadAgentCard` returns `{ url: DEFAULT_NESTOR_CLOUD_A2A_URL }`
- `:328` — test name: `'fetches the v1 card, runs text/tool/cancel/context smoke checks, and keeps state sidecar-only'`
- `:331` — `expect(card.url).toBe(DEFAULT_NESTOR_CLOUD_A2A_URL)`
- `:332` — `expect(card.protocolVersion).toBeTruthy()` — **presence-only, never compared to a version**
- `:334` — `expect(card.supportedInterfaces?.some((iface) => iface.url === DEFAULT_NESTOR_CLOUD_A2A_URL)).toBe(true)`
- `:337` — `const v2CardUrl = DEFAULT_NESTOR_CLOUD_AGENT_CARD_URL.replace('/api/v1/', '/api/v2/')` — this string surgery INVERTS after the constant flips (it would rewrite v2→v2, probing nothing)
- `:289, :299, :307, :385, :395` — `NestorCloudContextStore` bindings with `endpoint: DEFAULT_NESTOR_CLOUD_A2A_URL`
- `:372` — `if (event.kind === 'task' && …)` — the 0.3 discriminator

**2. THE FROZEN FIXTURE — `packages/shared/src/agent/__tests__/fixtures/adjacent-backends/nestor-a2a.json`, driven by `packages/shared/src/agent/__tests__/adjacent-backend-frozen-contract.test.ts:295` (`test('drives Nestor adapter, turn handoff, terminal suppression, and A2A envelopes', …)`, fixture loaded at `:296` via `fixture<any>('nestor-a2a.json')`).**

This fixture does **not** pin the URL, but it **pins the 0.3 wire shape itself**, which is the harder blocker:
```
fixtures/adjacent-backends/nestor-a2a.json:84
      { "kind": "task", "id": "task-1", "contextId": "ctx-1", "status": { "state": "submitted" } },
fixtures/adjacent-backends/nestor-a2a.json:85
      { "kind": "status-update", "taskId": "task-1", "contextId": "ctx-1", "final": true, "status": { "state": "input-required", "message": { … } } },
fixtures/adjacent-backends/nestor-a2a.json:91
      { "kind": "status-update", …, "status": { "state": "completed", … } }
```
Verbatim pins: the `"kind"` discriminator (`"task"`, `"status-update"`, and inside parts `"text"`/`"data"`) and the lowercase task states `"submitted"`, `"input-required"`, `"completed"`. Per the gap analysis, A2A 1.0 replaces these with `TASK_STATE_*` strings and a oneof keyed `message`/`task`/`statusUpdate`/`artifactUpdate` **with no `kind` discriminator** (`docs/superpowers/specs/2026-08-22-nestor-remote-agent-gap-analysis.md:207`). **This is a shared, outside-the-module fixture that must be regenerated or dual-armed.**

**3. `docs-site/` — no URL or version pin.** Only two generic prose lines, both safe to leave:
- `docs-site/content/reference/config/llm-connections.md:82` and `docs-site/content/ru/reference/config/llm-connections.md:82` — `` | `nestor-cloud-agent` | Native Nestor cloud code-agent over the A2A protocol (Nessy Gateway sign-in) | ``
- `docs-site/content/reference/config/llm-connections.md:465` — `` - **`nestor-cloud-agent`** → `"queue"` ``

**4. `docs/testing/cdp-live-checklist.md` — NOT FOUND.** `grep -a` for `Nessy Cloud`, `nestor-cloud`, `nessy-cloud`, and `code-agent` returns no case row. There is no live case for this backend to update.

**5. No protocol-version constant exists anywhere to update.** Repo-wide `grep -a "protocolVersion"` outside `docs/`: the only A2A hits are `packages/shared/src/agent/backend/nestor-cloud/types.ts:80` (`protocolVersion?: string;`) and the presence-only throw at `client.ts:226-227` — both IN-module. `PROTOCOL_VERSION` in `packages/shared/src/protocol/types.ts` and `packages/server-core/src/transport/server.ts:426-437` is the **websocket envelope version, unrelated to A2A**.

---

### (e) `model-fetchers/nestor.ts` and `telemetry/gateway-headers.ts` — **neither touches the a2a endpoint**

`packages/server-core/src/model-fetchers/nestor.ts` is scoped to the CLI models path only:
```
packages/server-core/src/model-fetchers/nestor.ts:9   export const NESTOR_CLI_BASE_PREFIX = `https://${NESTOR_GATEWAY_HOST}/api/v1/cli/`
packages/server-core/src/model-fetchers/nestor.ts:10  const NESTOR_MODELS_URL = `${NESTOR_CLI_BASE_PREFIX}models`
packages/server-core/src/model-fetchers/nestor.ts:45  const res = await fetch(NESTOR_MODELS_URL, {
```
`/api/v1/cli/` ≠ `/api/v1/code-agent/a2a`. **No change.**

`packages/shared/src/telemetry/gateway-headers.ts` gates strictly on that same prefix and **already excludes the a2a endpoint today**:
```
packages/shared/src/telemetry/gateway-headers.ts:40  import { NESTOR_CLI_BASE_PREFIX } from '../auth/nestor.ts';
packages/shared/src/telemetry/gateway-headers.ts:68  if (!urlStr.startsWith(NESTOR_CLI_BASE_PREFIX)) return NO_HEADERS;
```
with `packages/shared/src/auth/nestor.ts:1` — `export const NESTOR_CLI_BASE_PREFIX = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/';`

So a2a traffic gets `NO_HEADERS` from this module before AND after the change — **no change, and no behaviour drift.** A2A auth comes from its own in-module builder (`nestor-cloud/auth.ts:42-46`: `'Nestor-Token'`, `'Device-Id'`, `'User-Agent'`), which is host-agnostic and version-agnostic.

---

### Addition 1 — shared-code change list (outside the module)

| Path | Change | Blocking? |
| --- | --- | --- |
| `packages/shared/src/agent/backend/internal/drivers/nestor-cloud.ts:4, :7` | `/api/v1/` → `/api/v2/` in both literals | **Yes — the whole change** |
| `packages/shared/src/agent/__tests__/fixtures/adjacent-backends/nestor-a2a.json:84-91` | regenerate stream envelopes for the 1.0 oneof + `TASK_STATE_*` | **Yes** |
| `packages/shared/src/agent/__tests__/adjacent-backend-frozen-contract.test.ts:295-…` | update assertions to the new fixture shape | **Yes** |
| `packages/shared/src/agent/__tests__/nestor-cloud-e2e.test.ts:37, :328, :331, :334, :337, :372, :289/:299/:307/:385/:395` | retarget; `:337`'s `.replace('/api/v1/','/api/v2/')` probe must be rewritten or dropped | Live-gated → not CI-blocking, but wrong |
| `packages/shared/src/agent/backend/internal/driver-types.ts:26-41` | optional: declare `agentCardUrl?: string` on `BackendRuntimePayload` | No |
| `docs-site/content/{,ru/}reference/config/llm-connections.md:82` | optional prose | No |

**No change required in:** `connection-setup-logic.ts`, `llm-connections.ts` (config), `storage.ts`, `gateway-one-click.ts`, `model-fetchers/nestor.ts`, `telemetry/gateway-headers.ts`, `auth/nestor.ts`, any `apps/electron` file, `docs/testing/cdp-live-checklist.md`.

---

## ADDITION 2 — a provider-gated `/quota` command

### (f) `parseSessionCommand` — file, kinds, and dispatch

**File: `packages/shared/src/slash-commands/session-command.ts`** (119 lines). Its own docblock, verbatim at `:1-3`: *"The ONE place that decides 'this text is an instruction to the SESSION, not a prompt'."*

**Full recognized-kind list** — the `ParsedSessionCommand` union at `:79-85`, and the parse order at `:97-118`:

| `kind` | Trigger | Pattern / parser | Argument |
| --- | --- | --- | --- |
| `'compact'` | `/compact [instructions]` | `COMPACT_PATTERN = /^\/compact(?:\s+([\s\S]+))?$/i` (`:87`), applied `:100-104` | `customInstructions?: string` |
| `'subtask'` | `/subtask <task>` | `parseSubtaskCommand` from `./subtask.ts` (`:24`, applied `:106-107`) | `task: string` |
| `'clear'` | `/clear` | `CLEAR_PATTERN = /^\/clear$/i` (`:88`), applied `:109` | none |
| `'btw'` | `/btw <question>` | `parseBtwCommand` from `./btw.ts` (`:23`, applied `:111-112`) | `question: string` (empty = documented REOPEN) |
| `'recap'` | `/recap` | `RECAP_PATTERN = /^\/recap$/i` (`:89`), applied `:114` | none |
| `'heapdump'` | `/heapdump` | `HEAPDUMP_PATTERN = /^\/heapdump$/i` (`:90`), applied `:116` | none |

Returns `null` otherwise (`:118`). Whole-message-only by design (`:93-95`).

**Its importers (all of them):** `base-agent.ts:92`, `codex-agent.ts:69`, `claude-agent.ts:107`, `pi-agent.ts:54`, `SessionManager.ts:389`, `App.tsx:11`, `slash-command-actions.ts:10`.

#### How a kind reaches an agent method — there are THREE distinct routes, not one

**Route A — executed at the `BaseAgent.chat` seam, never reaches a backend (`clear` only).**
```
packages/shared/src/agent/base-agent.ts:3696   const sessionCommand = parseSessionCommand(message);
packages/shared/src/agent/base-agent.ts:3697   if (sessionCommand) {
packages/shared/src/agent/base-agent.ts:3708     if (sessionCommand.kind === 'clear') {
packages/shared/src/agent/base-agent.ts:3710       await Promise.resolve(this.clearHistory());
packages/shared/src/agent/base-agent.ts:3711       this.config.onSdkSessionIdCleared?.();
packages/shared/src/agent/base-agent.ts:3714       yield { type: 'info', message: 'Context cleared — the next prompt starts a fresh conversation.' };
packages/shared/src/agent/base-agent.ts:3715       yield { type: 'complete' };
packages/shared/src/agent/base-agent.ts:3716       return;
packages/shared/src/agent/base-agent.ts:3717     }
packages/shared/src/agent/base-agent.ts:3718     yield* this.chatImpl(message.trim(), attachments, options);
packages/shared/src/agent/base-agent.ts:3719     return;
packages/shared/src/agent/base-agent.ts:3720   }
```
**This is the exact `/quota` template.** One arm, one `if`, covers all four backends. The chat surface is the `AgentEvent` `{ type: 'info'; message: string; level?: 'info' | 'warning' | 'error' | 'success' }` (`packages/core/src/types/message.ts:1059`).

**Route B — everything else falls through as a BARE message to `chatImpl`** (`base-agent.ts:3718`), where each backend re-parses: `pi-agent.ts:7352`, `codex-agent.ts:1298`. This is how `compact` and `subtask` reach their per-backend handling.

**Route C — the out-of-band `SessionCommand` RPC, bypassing `sendMessage` entirely** (`btw`, `recap`, `heapdump`).

**SessionManager's dispatch is NOT an exhaustive switch — it is three guards plus two state hooks.** In `sendMessage` (byte-exact line numbers; note `grep -an` under-reports this file by 4, awk and a byte-level scan agree):
```
packages/server-core/src/sessions/SessionManager.ts:18423   const parsedSessionCommand = parseSessionCommand(message)
packages/server-core/src/sessions/SessionManager.ts:18430   if (parsedSessionCommand?.kind === 'btw' || parsedSessionCommand?.kind === 'recap') {
packages/server-core/src/sessions/SessionManager.ts:18431     throw new Error(
packages/server-core/src/sessions/SessionManager.ts:18433       ? '/btw is answered out-of-band: use the sideQuestion session command, not sendMessage'
packages/server-core/src/sessions/SessionManager.ts:18434       : '/recap is answered out-of-band: use the recap session command, not sendMessage',
packages/server-core/src/sessions/SessionManager.ts:18440   if (parsedSessionCommand?.kind === 'heapdump') {
packages/server-core/src/sessions/SessionManager.ts:18441     throw new Error('/heapdump never reaches the model: use the heapdump session command, not sendMessage')
packages/server-core/src/sessions/SessionManager.ts:18443   const isSessionCommand = parsedSessionCommand !== null
packages/server-core/src/sessions/SessionManager.ts:18449   const heldTaskNotifications = managed.isProcessing || isSessionCommand ? undefined : managed.pendingTaskNotifications
packages/server-core/src/sessions/SessionManager.ts:18914   const pendingShellContext = isSessionCommand
packages/server-core/src/sessions/SessionManager.ts:18920   if (managed.wasInterrupted && !isSessionCommand) {
packages/server-core/src/sessions/SessionManager.ts:19051   if (parsedSessionCommand?.kind === 'clear') {   // managed-state reset after the turn
```
The generic `isSessionCommand` flag (`:18443`) already covers any NEW kind — a `/quota` kind gets the "don't fold held notifications / shell context into this turn" treatment for free, with **zero SessionManager edits**.

Route C's separate dispatcher is the exhaustive one:
```
packages/server-core/src/handlers/rpc/sessions.ts:822-833
      case 'sideQuestion':  return sessionManager.askSideQuestion(sessionId, command.question, workspaceId)
      case 'recap':         return sessionManager.generateSessionRecap(sessionId, workspaceId)
      case 'heapdump':      return sessionManager.heapdump(sessionId, workspaceId)
      default: { const _exhaustive: never = command; throw new Error(`Unknown session command: ${JSON.stringify(command)}`) }
```
with the `SessionCommand` union at `packages/shared/src/protocol/dto.ts:735-743` and result types `SideQuestionResult` (`:754-759`), `SessionRecapResult` (`:767-772`), `SessionHeapdumpResult` (`:781-788`).

---

### (g) How the composer surfaces slash commands — **BOTH: a static renderer registry, filtered by a backend-reported capability**

**Static registry (renderer):** `apps/electron/src/renderer/components/ui/slash-command-menu.tsx`
- `SlashCommandId` union — `:17`: `` export type SlashCommandId = PermissionMode | CustomSlashCommandId | 'agents' | 'automations' | 'btw' | 'compact' | 'context' | 'create-skill' | 'create-plugin' | 'export' | 'init' | 'memory' | 'model' | 'clear' | 'help' | 'recap' | 'subtask' | 'usage' ``
- one `const <name>Command: SlashCommand = { id, label, description, icon }` per command, `:145-268`
- `const featureCommands: SlashCommand[]` — `:270-287`
- `export const DEFAULT_SLASH_COMMANDS` — `:289-292`

**Backend-reported filter:** `ComposerCapabilities.slash`, declared at `packages/shared/src/protocol/dto.ts:87`:
```
  slash: { commandIds: string[] | 'all'; excludedCommandIds?: string[] }
```
with `:81` — *"`excludedCommandIds` subtracts from `commandIds` (additive-optional so old …)"*. Computed server-side in `packages/shared/src/agent/backend/composer-capabilities.ts:168-170`, delivered to the renderer via `SessionManager.ts:2319` (`composerCapabilities: resolveManagedComposerCapabilities(m),`, helper at `:2216-2230`) into the DTO field `packages/shared/src/protocol/dto.ts:258` (`composerCapabilities?: ComposerCapabilities`).

**Menu-side filtering:** `slash-command-menu.tsx:333-341` (`filterCommandsByCapability`), `:864-865`, `:890`, `:909-915`. **Action-side filtering:** `slash-command-actions.ts:52-61` (`isCommandAllowed`) and the early return at `:96-98`. Both are wired from `FreeFormInput.tsx:1126-1127` and `:1186-1187`.

**i18n — labels ARE localized, via flat dotted keys.** Two gates:
```
apps/electron/src/renderer/components/ui/slash-command-menu.tsx:379
const TRANSLATED_COMMAND_IDS = new Set<string>(['agents', 'automations', 'btw', 'clear', 'context', 'create-plugin', 'create-skill', 'export', 'help', 'init', 'memory', 'model', 'recap', 'subtask', 'usage'])
apps/electron/src/renderer/components/ui/slash-command-menu.tsx:390
  if (TRANSLATED_COMMAND_IDS.has(command.id)) return t(`commands.${command.id}.label`, command.label)
apps/electron/src/renderer/components/ui/slash-command-menu.tsx:411
  if (TRANSLATED_COMMAND_IDS.has(command.id)) return t(`commands.${command.id}.description`, command.description)
```
Locale files: `packages/shared/src/i18n/locales/en.json` and `ru.json`, **flat dotted keys**, 35 `commands.*` keys each. Confirmed existing pairs: `commands.usage.label = "Usage"` / `"Использование"`, `commands.usage.description = "Show session token usage"` / `"Показать токены этой сессии"`. Note the English literal in the `SlashCommand` object is the `t()` **default**, so an id absent from `TRANSLATED_COMMAND_IDS` silently ships English only.

---

### (h) MINIMAL wiring for a provider-gated `/quota`

There are two viable designs. **The `/clear` shape (Route A) is by far the cheaper one** and is what I'd recommend.

#### Design 1 (recommended) — `/quota` as a session command executed at the `BaseAgent.chat` seam

Every file outside the module that must change:

| # | Path | Change | Anchor line |
| --- | --- | --- | --- |
| 1 | `packages/shared/src/slash-commands/session-command.ts` | Add `export interface ParsedQuotaCommand { kind: 'quota' }`; add it to the `ParsedSessionCommand` union; add `const QUOTA_PATTERN = /^\/quota$/i;`; add `if (QUOTA_PATTERN.test(trimmed)) return { kind: 'quota' };` | union `:79-85`; patterns `:87-90`; parse `:109`/`:116` (place it beside the other whole-message, no-arg kinds) |
| 2 | `packages/shared/src/agent/base-agent.ts` | Inside the existing `if (sessionCommand)` block, add a `kind === 'quota'` arm alongside the `'clear'` arm. Base impl yields a "not supported on this runtime" `info` and returns; `NestorCloudAgent` overrides one `protected async fetchQuota()` hook. Follow the `/clear` shape exactly: `yield { type: 'info', message }` then `yield { type: 'complete' }` then `return` — do **not** fall through to `:3718`. | insert between `:3717` and `:3718` |
| 3 | `apps/electron/src/renderer/components/ui/slash-command-menu.tsx` | Add `'quota'` to `SlashCommandId`; add `const quotaCommand: SlashCommand = { id: 'quota', label: 'Quota', description: '…', icon: <… className={MENU_ICON_SIZE} /> }`; add `quotaCommand` to `featureCommands`; add `'quota'` to `TRANSLATED_COMMAND_IDS` | `:17`; new const near `:228-233`; array `:270-287`; set `:379` |
| 4 | `apps/electron/src/renderer/components/app-shell/input/slash-command-actions.ts` | Add `quota: '/quota',` to `MESSAGE_COMMANDS` — that alone routes it through the existing `submitCommand` path at `:175-180` | `MESSAGE_COMMANDS` `:71-90` |
| 5 | `packages/shared/src/agent/backend/composer-capabilities.ts` | **The provider gate.** Today the nestor arm at `:168-170` is subtractive-only. Invert it so `'quota'` is excluded for every provider EXCEPT `nestor-cloud-agent`: e.g. `input.provider === 'nestor-cloud-agent' ? { commandIds: 'all', excludedCommandIds: ['btw', 'recap'] } : { commandIds: 'all', excludedCommandIds: ['quota'] }` | `:161-186`, specifically `:168-170` |
| 6 | `packages/shared/src/i18n/locales/en.json` | Add `"commands.quota.label"` and `"commands.quota.description"` | flat keys |
| 7 | `packages/shared/src/i18n/locales/ru.json` | Same two keys (parity + sorted lints are gate commands) | flat keys |

**Files that do NOT need to change** — worth stating, because each looks like it should:
- `packages/server-core/src/sessions/SessionManager.ts` — the generic `isSessionCommand` flag at `:18443` already handles a new kind. Add a guard here ONLY if `/quota` must be refused when relayed/headless (it need not be — it is harmless as a turn).
- `packages/shared/src/protocol/dto.ts` — no new `SessionCommand` member; Route A rides `sendMessage`.
- `packages/server-core/src/handlers/rpc/sessions.ts` — untouched (its `default: { const _exhaustive: never = command; … }` at `:830-833` would force a change only under Design 2).
- `apps/electron/src/shared/types.ts:430` — the `sessionCommand` return union is untouched.
- `packages/shared/src/agent/{pi,codex,claude}-agent.ts` — their `parseSessionCommand` call sites re-parse but only branch on kinds they know; an unknown kind falls through to their normal handling, and Route A returns before `chatImpl` is entered.

**Caveat to verify at implementation time:** `slash-command-actions.ts:175` gates `MESSAGE_COMMANDS` on `handlers.isProcessing`, so menu-selected `/quota` is unavailable mid-turn (same as `/compact` and `/clear`). If quota must be readable while the agent is working, `/quota` needs its own early-exit above that block, mirroring the `btw`/`recap` exits at `:154-162`.

#### Design 2 (not recommended) — `/quota` as an out-of-band `SessionCommand` RPC

Copying the `recap` precedent adds, on top of items 1/3/5/6/7 above: a `| { type: 'quota' }` member and a `SessionQuotaResult` interface in `packages/shared/src/protocol/dto.ts` (near `:738` and `:767-772`); a `case 'quota':` in `packages/server-core/src/handlers/rpc/sessions.ts` (near `:824`) — **mandatory**, its `default` is `never`-typed; a method on `packages/server-core/src/handlers/session-manager-interface.ts` (near `:219-224`) and its `SessionManager` implementation; the return-type union at `apps/electron/src/shared/types.ts:430`; a `requestQuota` handler in `SlashCommandActionHandlers` (`slash-command-actions.ts:13-40`), its dispatch arm (near `:159-162`), its callback + two dep arrays in `FreeFormInput.tsx` (`:1092`, `:1135`, `:1151`, `:1590`); and a typed-input arm in `typedOutOfBandCommandSubmission` (`slash-command-actions.ts:198-207`). **Roughly 3× the shared-code surface for no user-visible gain** — the only thing it buys is availability during a turn and non-persistence in the transcript.

#### The alternative that touches NO shared code: a status event

Surface remaining daily limit entirely from inside `packages/shared/src/agent/nestor-cloud-agent.ts` — emit an `AgentEvent` (`{ type: 'info', message, level }`, `packages/core/src/types/message.ts:1059`, the same event `/clear` uses at `base-agent.ts:3714`) at turn start and/or when a 429 is seen. `chatImpl` already yields freely (`nestor-cloud-agent.ts:77`), and `GET /api/v1/quota` is **entirely unused today** — repo-wide `grep -ari quota` outside `docs/` returns zero references to that endpoint; every hit is unrelated (`codex-responses-adapter/src/errors.ts:70-77`, `llm-validation.ts:123-125`, plugin dependency quota in `plugins/acquisition.ts:2326`, Claude's `rate_limit_event` at `backend/claude/event-adapter.ts:1374`).

**Zero files outside the module change. Zero i18n keys. Zero capability-gating work.**

**Its UX cost, concretely:**
- **Not user-invocable.** The user cannot ask "how much do I have left?" — they must start a turn (or hit a 429) to find out. Answering the question costs a real request.
- **Not discoverable.** Nothing appears in the slash menu, so a user who never reads an info row never learns the feature exists.
- **Noisy or stale, pick one.** Emitting every turn adds a row to every conversation; emitting only on 429 means the number is invisible until it is already too late.
- **Non-localizable at the natural site.** The message would be an English literal in shared code — this repo has already recorded that exact regression for this exact backend: `slash-command-menu.tsx:400-408` documents that `NESTOR_CLOUD_MODE_OPTIONS` "hardcodes English literals," so "a Russian user on that connection now reads the backend's own English here," and names the fix as *"localize the cloud overrides at their source in `composer-capabilities.ts`"* — i.e. shared-code work deferred, not avoided.
- **Wrong tense for a "remaining daily limit."** A turn-start snapshot is stale by the time the turn ends.

**My read:** the status event is a legitimate *v0* — genuinely zero shared-code risk — but it does not answer "what's my remaining limit right now?", which is the actual request. Design 1's cost is seven files, of which two are one-line i18n additions and two are one-line registry additions; only items 1, 2, and 5 involve real logic. That is a proportionate price for an invocable command.

---

### (i) Existing per-provider slash-command precedent

**Yes, but it is SUBTRACTIVE only — there is no additive per-provider command in the codebase today, and `/quota` would be the first.**

The one precedent, and it is this very backend:
```
packages/shared/src/agent/backend/composer-capabilities.ts:164-170
    // `btw`/`recap` ride the tool-less `queryLlm`/mini-completion route, and
    // NestorCloudAgent's `queryLlm` throws by design (remote agent, no local
    // query substrate) — so the composer must not offer commands that cannot
    // answer there. Every other provider keeps the full set.
    slash: input.provider === 'nestor-cloud-agent'
      ? { commandIds: 'all', excludedCommandIds: ['btw', 'recap'] }
      : { commandIds: 'all' },
```

**Copy this pattern.** Its full enforcement chain is already built and tested end to end:
- **Type:** `packages/shared/src/protocol/dto.ts:87` — `slash: { commandIds: string[] | 'all'; excludedCommandIds?: string[] }`
- **Server → renderer:** `SessionManager.ts:2319`, helper `:2216-2230`; recomputed on runtime switch at `SessionManager.ts:15963-15967`
- **Menu enforcement:** `slash-command-menu.tsx:339-341` — `commands.filter(command => !excludedCommandIds.includes(command.id))`
- **Action enforcement:** `slash-command-actions.ts:57` — `if (excludedCommandIds?.includes(commandId)) return false`
- **Test precedent to copy:** `apps/electron/src/renderer/components/app-shell/input/__tests__/slash-command-actions.test.ts:246-251` — `it('honors slash.excludedCommandIds — an excluded command never dispatches', …)`, whose comment reads *"nestor-cloud-agent excludes btw/recap because its queryLlm throws."* Also `packages/shared/src/agent/backend/__tests__/composer-capabilities.test.ts:195-197` — `expect(nestor.slash).toEqual({ commandIds: 'all', excludedCommandIds: ['btw', 'recap'] })`.

**Two notes on using it for `/quota`:**

1. **The array form of `commandIds` is dead code.** `commandIds: string[]` is typed and honoured (`slash-command-actions.ts:58-60`) but **nothing in the repo ever passes an array** — every production call site passes `'all'`. So the natural "allowlist for one provider" spelling is untested in practice; the exclusion spelling is the one with coverage. Prefer excluding `'quota'` everywhere else over allowlisting it for nestor.

2. **A drift guard will catch you.** `packages/shared/src/agent/__tests__/runtime-capability-drift.test.ts` and `apps/electron/src/renderer/components/app-shell/input/__tests__/runtime-capability-drift.test.ts` both hold per-provider capability tables with `'nestor-cloud-agent': true` rows (`:88`, `:99` and `:61`, `:70` respectively), and the renderer one asserts membership *"as a set difference, never as a count"* (`:179`). Expect to update both when the slash shape changes.

**Adjacent precedent worth knowing:** `contextUsage` is resolved per provider through a dedicated helper, `resolveContextUsageCapability(input.provider)` (`composer-capabilities.ts:184`), and `/compact` is gated on it in the renderer at `slash-command-actions.ts:172-174` (`if (commandId === 'compact' && handlers.contextUsageCapability?.compact?.manual === false) return false`). That is the pattern to copy if `/quota` ever needs richer per-provider shape than a boolean include/exclude.

---

## Summary

**Addition 1 is small and safe.** One production file outside the module holds the URL (`drivers/nestor-cloud.ts:4, :7`), and — the key finding — **the v1 URL is never persisted per connection**: `createBuiltInConnection` omits `baseUrl` from its return object (`connection-setup-logic.ts:328-339`), the Cloud card sends `{ slug }` alone (`gateway-one-click.ts:73-77`), and the setup handler's write is gated on `setup.baseUrl !== undefined` (`rpc/llm-connections.ts:74`). Flipping the constant migrates every existing user on next launch with no config migration. Existing context sidecars self-invalidate through `matchesBindings`' `endpoint` comparison (`context-store.ts:115`) and silently restart with a fresh remote context — which is correct, since a 0.3 `contextId` is not valid on the 1.0 handler.

**The real work in Addition 1 is not the URL — it is the shared frozen fixture** `packages/shared/src/agent/__tests__/fixtures/adjacent-backends/nestor-a2a.json:84-91`, which pins the 0.3 `"kind"` discriminator and lowercase `"submitted"`/`"input-required"`/`"completed"` states that A2A 1.0 replaces wholesale. `model-fetchers/nestor.ts` and `telemetry/gateway-headers.ts` are both scoped to the `/api/v1/cli/` prefix and are unaffected in either direction.

**Addition 2 costs seven files** via the `/clear` seam pattern (`base-agent.ts:3708-3717`), of which only three carry logic. The per-provider gate has an exact, tested precedent in `composer-capabilities.ts:168-170` — though note it is subtractive-only, and the `commandIds: string[]` allowlist form, while typed and honoured, is never exercised in production. The no-shared-code alternative (a status event on turn start / 429) is real and genuinely free, but it cannot answer the user's question on demand, is undiscoverable, and — per this repo's own recorded regression at `slash-command-menu.tsx:400-408` — would ship an unlocalized English literal for this same backend, deferring rather than avoiding the shared-code change.

**No files were modified.**