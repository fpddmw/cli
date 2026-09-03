import { StringDecoder } from "node:string_decoder";
import { ARTIFACT_VIEW_TOOL_NAMES } from "./artifact-view-mcp.js";
import { isObject } from "./storage.js";

/** Codex exec's JSONL MCP envelope, verified against exec/src/exec_events.rs.
 * This reduces only the controller's duplicate transport log, never MCP bytes
 * delivered to the model or the permanent object/read-receipt store. */
export function isPacketArtifactTool(item: unknown): boolean {
  return (
    isObject(item) &&
    item.type === "mcp_tool_call" &&
    item.server === "research_artifacts" &&
    ARTIFACT_VIEW_TOOL_NAMES.includes(item.tool as (typeof ARTIFACT_VIEW_TOOL_NAMES)[number])
  );
}

const MAX_METADATA_PREFIX = 65_536;
export function codexArtifactTrace(input: {
  maxControlBytes: number;
  line: (value: Buffer) => void;
  oversized: () => void;
}) {
  const decoder = new StringDecoder("utf8");
  let pieces: string[] = [];
  let bytes = 0;
  let prefix = "";
  let allowedLargePayload = false;
  let stopped = false;
  const append = (text: string) => {
    if (stopped || !text) return;
    pieces.push(text);
    bytes += Buffer.byteLength(text);
    if (!allowedLargePayload && prefix.length < MAX_METADATA_PREFIX) {
      prefix += text.slice(0, MAX_METADATA_PREFIX - prefix.length);
      allowedLargePayload = hasArtifactResultPrefix(prefix);
    }
    if (bytes > input.maxControlBytes && !allowedLargePayload) {
      stopped = true;
      pieces = [];
      input.oversized();
    }
  };
  const flush = () => {
    if (stopped) return;
    const text = pieces.join("");
    pieces = [];
    bytes = 0;
    prefix = "";
    allowedLargePayload = false;
    input.line(Buffer.from(`${compactArtifactEvent(text)}\n`));
  };
  const accept = (text: string) => {
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      if (end < 0) {
        append(text.slice(start));
        return;
      }
      append(text.slice(start, end));
      flush();
      start = end + 1;
    }
  };
  return {
    write: (chunk: Buffer) => accept(decoder.write(chunk)),
    end: () => {
      accept(decoder.end());
      if (pieces.length) flush();
    },
  };
}

function hasArtifactResultPrefix(prefix: string) {
  // A genuine top-level item.result can be replaced with null to close this
  // small envelope. Nested keys/quoted strings do not parse as that envelope.
  const match = /,\s*"result"\s*:/u.exec(prefix);
  if (!match) return false;
  try {
    const event: unknown = JSON.parse(`${prefix.slice(0, match.index)},"result":null}}`);
    return (
      isObject(event) &&
      ["item.completed", "item.updated"].includes(String(event.type)) &&
      isPacketArtifactTool(event.item)
    );
  } catch {
    return false;
  }
}

function compactArtifactEvent(text: string) {
  try {
    const event: unknown = JSON.parse(text);
    if (
      !isObject(event) ||
      !["item.completed", "item.updated"].includes(String(event.type)) ||
      !isObject(event.item) ||
      !isPacketArtifactTool(event.item) ||
      event.item.error ||
      event.item.status === "failed" ||
      !isObject(event.item.result)
    )
      return text;
    return JSON.stringify({
      ...event,
      item: {
        ...event.item,
        result: {
          controllerTrace:
            "duplicate artifact payload omitted; exact bytes and reads retained separately",
        },
      },
    });
  } catch {
    return text;
  }
}
