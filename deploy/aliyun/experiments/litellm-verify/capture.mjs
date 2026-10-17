// Fake Anthropic Messages API. Logs the request headers LiteLLM sends upstream
// (credentials redacted) and answers with a fixed usage so pricing can be
// checked exactly: 1000 input, 5000 cache read, 300 cache write, 200 output.
import http from "node:http";
import fs from "node:fs";

const LOG = "/data/capture-headers.jsonl";
const USAGE = { input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, output_tokens: 200 };
const SECRET = /^(authorization|x-api-key|api-key)$/i;

http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, SECRET.test(k) ? "[redacted]" : v]));
    fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), method: req.method, path: req.url, headers })}\n`);
    if (req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    let request = {};
    try { request = JSON.parse(body || "{}"); } catch { /* keep defaults */ }
    const id = `msg_capture_${Date.now()}`;
    const model = request.model ?? "capture";
    const text = "ok";
    if (!request.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        id, type: "message", role: "assistant", model, stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text }], usage: USAGE,
      }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
      usage: { ...USAGE, output_tokens: 1 } } });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USAGE.output_tokens } });
    send("message_stop", {});
    res.end();
  });
}).listen(8080, () => console.log("capture listening on 8080"));
