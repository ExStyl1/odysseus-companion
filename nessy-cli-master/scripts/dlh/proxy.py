#!/usr/bin/env python3
import sys
# Отключаем буферизацию для немедленного вывода в лог
sys.stdout.reconfigure(line_buffering=True)

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import datetime

FIELDS = {
    "message":    ["message_id", "session_id", "prompt_id", "role", "content"],
    "request":    ["parent_prompt_id", "prompt_id", "session_id", "agent_name", "agent_hash", "parent_tool_call_id", "agent_params_json"],
    "inference":  ["prompt_text_length", "type", "inference_id", "prompt_id", "session_id", "model_response_length", "model_id", "model_response", "status"], # "prompt_text", "model_response",
    "tool_call":  ["call_json", "response", "tool_call_id", "prompt_id", "session_id", "inference_id", "function_name", "client_created_at", "client_finished_at", "client_approve_sent_at", "client_approve_received_at", "decision", "status"],
    "event":      ["event_id", "session_id", "prompt_id", "type", "payload_json", "payload_json_length", "client_created_at", "sensitive_data_filtered"],
}


def filter_event(event: dict) -> dict:
    event_type = event.get("type")
    data = event.get("data", {})
    fields = FIELDS.get(event_type)
    # fields == None → показываем все поля; иначе оставляем только перечисленные
    if fields is not None:
        data = {k: data[k] for k in fields if k in data}
    return {"type": event_type, "data": data}


class LoggingHandler(BaseHTTPRequestHandler):
    def handle_request(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", errors="replace") if length else ""

        if body:
            try:
                parsed = json.loads(body)
                events = parsed.get("events", [parsed])
                events = [e for e in events if e.get("type") in FIELDS]
                if not events:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"status":"ok"}')
                    return
                filtered = [filter_event(e) for e in events]
                print(json.dumps({"events": filtered}, indent=2, ensure_ascii=False))
            except Exception:
                print(f"Body:\n{body}")
        print(f"{'='*70}")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def do_GET(self):    self.handle_request()
    def do_POST(self):   self.handle_request()
    def do_PUT(self):    self.handle_request()
    def do_PATCH(self):  self.handle_request()
    def do_DELETE(self): self.handle_request()
    def do_HEAD(self):   self.handle_request()

    def log_message(self, fmt, *args):
        pass  # подавляем стандартный лог, у нас свой


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8080), LoggingHandler)
    print(f"Listening on http://0.0.0.0:8080 (showing: {', '.join(FIELDS.keys())})")
    print("Press Ctrl+C to stop\n")
    server.serve_forever()
