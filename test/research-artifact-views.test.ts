import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  openArtifactViews,
  artifactPromptContext,
  persistArtifactReads,
  persistArtifactViewIndex,
  writeArtifactViewIndex,
} from "../src/research/workspace/artifact-views.js";
import {
  canonicalJson,
  sha256Bytes,
  sha256Text,
  workspacePaths,
  writeTextAtomic,
  writeJsonAtomic,
} from "../src/research/workspace/storage.js";
import { loadVerifiedReviewPacket } from "../src/research/workspace/runtime.js";
import { startArtifactViewServer } from "../src/research/workspace/artifact-view-mcp.js";
import { executeAgent } from "../src/research/workspace/executor.js";
import { scientificReviewSchema } from "../src/research/workspace/scientific-review.js";
import { claudeCodeCompatibleSchema } from "../src/research/workspace/schema-compatibility.js";
import { researchPlatformCapabilities } from "../src/research/workspace/platform-capabilities.js";

async function fixture(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), "artifact-views-"));
  const project = join(root, "capsule");
  const permanent = join(root, "permanent");
  await mkdir(project);
  await mkdir(permanent);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(project, name, ".."), { recursive: true });
    await writeFile(join(project, name), content);
  }
  const binding = await writeArtifactViewIndex(project, "view-project");
  const packetSha256 = sha256Text("fixed reviewed packet");
  const views = await openArtifactViews(project, binding, packetSha256);
  return {
    root,
    project,
    permanent,
    binding,
    packetSha256,
    views,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

it("removes Claude schema dialect annotations without changing constraints or literal data", () => {
  const schema = scientificReviewSchema("research-design");
  const original = structuredClone(schema);
  const compatible = claudeCodeCompatibleSchema(schema);
  assert.equal(compatible.$schema, undefined);
  assert.deepEqual(schema, original, "The canonical controller schema must remain unchanged");
  const { $schema: _dialect, ...constraints } = original;
  const properties = constraints.properties as Record<string, Record<string, unknown>>;
  properties.schemaVersion!.type = "integer";
  properties.role!.type = "string";
  properties.decision!.type = "string";
  const finding = properties.findings!.items as {
    properties: Record<string, Record<string, unknown>>;
  };
  finding.properties.severity!.type = "string";
  assert.deepEqual(compatible, constraints);
  const literal = { $schema: "literal-data", $id: "literal-identity" };
  const propertySchema = { type: "string", minLength: 1 };
  assert.deepEqual(
    claudeCodeCompatibleSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/value",
      type: "object",
      properties: { $schema: propertySchema, payload: { const: literal } },
      required: ["$schema", "payload"],
      additionalProperties: false,
    }),
    {
      type: "object",
      properties: { $schema: propertySchema, payload: { const: literal } },
      required: ["$schema", "payload"],
      additionalProperties: false,
    },
  );
});

describe("snapshot-bound on-demand artifact views", () => {
  it("revalidates a persistent review packet's artifact directory at the live trust boundary", async () => {
    const fx = await fixture({ "inputs/source.txt": "Exact original evidence.\n" });
    try {
      const projectRoot = join(workspacePaths(fx.root).projects, "view-project");
      await mkdir(projectRoot, { recursive: true });
      const index = await persistArtifactViewIndex(projectRoot, fx.project, fx.binding);
      const content = "Initial context, not the complete evidence.\n";
      const context = {
        path: `review/contexts/${sha256Text(content)}.txt`,
        sha256: sha256Text(content),
        bytes: Buffer.byteLength(content),
      };
      await writeTextAtomic(join(projectRoot, context.path), content);
      const core = {
        schemaVersion: 1,
        projectId: "view-project",
        reviewEvidenceContext: context,
        snapshotChain: [],
        artifactViews: index,
      };
      const packetSha256 = sha256Text(canonicalJson(core));
      await writeJsonAtomic(join(projectRoot, "review/packets", `${packetSha256}.json`), {
        ...core,
        packetSha256,
      });
      await loadVerifiedReviewPacket(fx.root, "view-project", packetSha256);
      await writeJsonAtomic(join(projectRoot, index.path), {
        schemaVersion: 1,
        kind: "tiangong-artifact-view-index",
        projectId: "view-project",
        objects: [],
      });
      await assert.rejects(
        loadVerifiedReviewPacket(fx.root, "view-project", packetSha256),
        /artifact|directory|view/i,
      );
    } finally {
      await fx.cleanup();
    }
  });
  it("applies the same secret refusal to small inline artifacts as to on-demand reads", async () => {
    const fx = await fixture({
      "outputs/unsafe.txt": "Authorization: Bearer private-inline-fixture-token\n",
    });
    try {
      await assert.rejects(artifactPromptContext(fx.project, fx.binding, ["outputs/unsafe.txt"]), {
        code: "RESEARCH_ARTIFACT_VIEW_SENSITIVE",
      });
    } finally {
      await fx.cleanup();
    }
  });

  it("persists EOF probes and empty artifacts exactly without treating them as full-object rereads", async () => {
    const fx = await fixture({
      "outputs/empty.txt": "",
      "outputs/result.txt": "A complete result.",
    });
    try {
      for (const item of fx.views.index.objects) {
        const read = await fx.views.read({ objectId: item.objectId, offset: item.bytes });
        assert.equal(read.content, "");
        assert.equal(read.receipt.deliveredBytes, 0);
        await persistArtifactReads(fx.permanent, fx.project, fx.binding, fx.packetSha256, [
          read.receipt,
        ]);
        const receipt = JSON.parse(
          await readFile(
            join(fx.permanent, "reads/receipts", `${read.receipt.receiptSha256}.json`),
            "utf8",
          ),
        );
        assert.deepEqual(receipt, read.receipt);
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("serves only the two read-only MCP tools and rejects hostile origins and extra arguments", async () => {
    const fx = await fixture({ "outputs/evidence.txt": "A failed check remains visible.\n" });
    const server = await startArtifactViewServer(fx.views);
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return response.json() as Promise<{ result: Record<string, unknown> }>;
    };
    try {
      const initialized = await rpc("initialize", { protocolVersion: "2025-11-25" });
      assert.equal(initialized.result.protocolVersion, "2025-11-25");
      const listed = await rpc("tools/list");
      const tools = listed.result.tools as Array<{
        name: string;
        annotations: Record<string, boolean>;
      }>;
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["research_list_artifacts", "research_read_artifact"],
      );
      assert.ok(
        tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint),
      );
      const view = await rpc("tools/call", {
        name: "research_read_artifact",
        arguments: { objectId: fx.views.index.objects[0]!.objectId },
      });
      const fallback = JSON.parse(
        (view.result.content as Array<{ text: string }>)[0]!.text,
      ) as Record<string, unknown>;
      const clientVisible = (view.result.structuredContent ?? fallback) as Record<string, unknown>;
      assert.equal(clientVisible.objectSha256, sha256Text("A failed check remains visible.\n"));
      assert.equal(
        clientVisible.content,
        "A failed check remains visible.\n",
        "A client preferring structuredContent must receive actual content, not only receipts",
      );
      const invalid = await rpc("tools/call", {
        name: "research_read_artifact",
        arguments: { objectId: fx.views.index.objects[0]!.objectId, path: "/private/credentials" },
      });
      assert.equal(invalid.result.isError, true);
      assert.equal(JSON.stringify(invalid).includes("/private/credentials"), false);
      const blocked = await fetch(server.url, {
        method: "POST",
        headers: { Origin: "https://hostile.test" },
        body: "{}",
      });
      assert.equal(blocked.status, 403);
      assert.equal((await fetch(server.url)).status, 405);
    } finally {
      await server.stop();
      await fx.cleanup();
    }
  });

  it(
    "connects actual isolated Codex and Claude processes to exact packet reads without capping duplicated artifact traces",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      for (const [agent, padding] of [
        ["codex", 0],
        ["claude", 0],
        ["codex", 6 * 1024 * 1024],
      ] as const) {
        const source = "Critical negative result.\n" + "x".repeat(padding);
        const fx = await fixture({ "outputs/counterevidence.txt": source });
        try {
          const binary = join(fx.root, `fake-${agent}.mjs`);
          await writeFile(
            binary,
            `#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
if (process.argv.includes('--version')) { console.log('fake-artifact-reviewer 1'); process.exit(0); }
const args = process.argv.slice(2);
let url;
if (${JSON.stringify(agent)} === 'codex') {
  assert.ok(args.includes('shell_tool') && args.includes('unified_exec'));
  url = JSON.parse(args.find(arg => arg.startsWith('mcp_servers.research_artifacts.url=')).split('=').slice(1).join('='));
} else {
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__research_artifacts__research_list_artifacts,mcp__research_artifacts__research_read_artifact');
  assert.ok(args.includes('--strict-mcp-config'));
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.equal(schema.$schema, undefined, 'Claude CLI rejects the Draft 2020-12 meta-schema before model execution');
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.properties.schemaVersion.type, 'integer', 'A numeric constant must not be encoded as a string by the structured-output tool');
  assert.deepEqual(schema.properties.decision.enum, ['pass', 'revise', 'stop', 'handoff']);
  url = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.research_artifacts.url;
}
async function rpc(method, params) {
 const response = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const body = await response.json(); return body.result;
}
await rpc('initialize', {protocolVersion:'2025-03-26'});
const directory = JSON.parse((await rpc('tools/call',{name:'research_list_artifacts',arguments:{}})).content[0].text);
const selection = {objectId:directory.items[0].objectId,length:null};
const toolResult = await rpc('tools/call',{name:'research_read_artifact',arguments:selection});
const content = ${JSON.stringify(agent)} === 'claude' && toolResult.structuredContent
  ? toolResult.structuredContent : JSON.parse(toolResult.content[0].text);
assert.equal(typeof content.content, 'string', 'The model-visible result must include artifact bytes');
assert.equal(createHash('sha256').update(content.content).digest('hex'), ${JSON.stringify(sha256Text(source))});
if (${JSON.stringify(agent)} === 'codex') {
 console.log(JSON.stringify({type:'item.completed',item:{id:'read-exact-source',type:'mcp_tool_call',server:'research_artifacts',tool:'research_read_artifact',arguments:selection,result:{content:toolResult.content,structured_content:null},error:null,status:'completed'}}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));
} else console.log(JSON.stringify({result:'{"ok":true}',usage:{input_tokens:2,output_tokens:1}}));
`,
          );
          await chmod(binary, 0o755);
          const result = await executeAgent({
            route: { agent, binary, model: "packet-review-test" },
            prompt: "Inspect the negative result.",
            outputSchema:
              agent === "claude"
                ? scientificReviewSchema("research-design")
                : {
                    type: "object",
                    properties: { ok: { const: true } },
                    required: ["ok"],
                    additionalProperties: false,
                  },
            requestId: "packet-read-test",
            purpose: "primary",
            capsuleRoot: fx.root,
            projectRoot: fx.project,
            workspaceRoot: fx.root,
            timeoutSeconds: 10,
            maxTurns: 8,
            maxOutputTokens: 100,
            maxCostUsd: 1,
            toolPolicy: "packet-read",
            artifactViews: { index: fx.binding, packetSha256: fx.packetSha256 },
            environment: { PATH: process.env.PATH },
            brokerUrl: null,
          });
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(result.stdout, '{"ok":true}');
          assert.equal(result.isolation?.toolPolicy, "packet-read");
          assert.equal(result.isolation?.networkPolicy, "reviewer-provider-and-local-artifacts");
          assert.equal(result.artifactReads?.length, 1);
          assert.equal(result.artifactReads?.[0]?.objectSha256, sha256Text(source));
        } finally {
          await fx.cleanup();
        }
      }
    },
  );

  it(
    "does not accept a packet-read result when Codex reports general file editing",
    { skip: !researchPlatformCapabilities().nativeReviewerExecution },
    async () => {
      const fx = await fixture({ "outputs/source.txt": "Read-only input.\n" });
      try {
        const binary = join(fx.root, "fake-unexpected-tool.mjs");
        await writeFile(
          binary,
          `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fake-review-policy 1'); process.exit(0); }
console.log(JSON.stringify({type:'item.completed',item:{id:'unexpected-write',type:'file_change',changes:[{path:'unrequested-file.txt',kind:'add'}],status:'completed'}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'{"ok":true}'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));
`,
        );
        await chmod(binary, 0o755);
        const result = await executeAgent({
          route: { agent: "codex", binary, model: "packet-policy-test" },
          prompt: "Read only the exact supplied source.",
          outputSchema: {
            type: "object",
            properties: { ok: { const: true } },
            required: ["ok"],
            additionalProperties: false,
          },
          requestId: "unexpected-tool-test",
          purpose: "primary",
          capsuleRoot: fx.root,
          projectRoot: fx.project,
          workspaceRoot: fx.root,
          timeoutSeconds: 10,
          maxTurns: 8,
          maxOutputTokens: 100,
          maxCostUsd: 1,
          toolPolicy: "packet-read",
          artifactViews: { index: fx.binding, packetSha256: fx.packetSha256 },
          environment: { PATH: process.env.PATH },
          brokerUrl: null,
        });
        assert.notEqual(result.exitCode, 0);
        assert.match(result.stderr, /tool policy/i);
      } finally {
        await fx.cleanup();
      }
    },
  );

  it("has no total corpus or requested read length ceiling and never discovers later files", async () => {
    const text = "counterevidence retained even after the first page\n".repeat(10_000);
    const fx = await fixture({
      "outputs/large.txt": text,
      "outputs/second.txt": "Second artifact.",
    });
    try {
      await writeFile(
        join(fx.project, "outputs/later-secret.txt"),
        "Must remain outside the snapshot.",
      );
      const first = fx.views.list({ limit: 1 });
      assert.equal(first.total, 2);
      assert.equal(first.hasMore, true);
      assert.equal(fx.views.list({ offset: first.nextOffset!, limit: 1 }).items.length, 1);
      const item = fx.views.index.objects.find((item) => item.path.endsWith("large.txt"))!;
      const read = await fx.views.read({ objectId: item.objectId, length: null });
      assert.equal(read.content, text);
      assert.equal(read.hasMore, false);
      assert.equal(read.receipt.objectSha256, sha256Text(text));
      assert.equal(
        fx.views.list().items.some((item) => item.path.endsWith("later-secret.txt")),
        false,
      );
      await assert.rejects(fx.views.read({ objectId: "outputs/later-secret.txt" }), {
        code: "RESEARCH_ARTIFACT_VIEW_INVALID",
      });
    } finally {
      await fx.cleanup();
    }
  });

  it("preserves UTF-8 boundaries and scans a selected object only once across adjacent pages", async () => {
    const text = "证据🙂反例\r\n".repeat(100);
    const fx = await fixture({ "inputs/content.txt": text });
    try {
      const id = fx.views.index.objects[0]!.objectId;
      let offset = 0;
      let actual = "";
      for (;;) {
        const result = await fx.views.read({ objectId: id, offset, length: 17 });
        actual += result.content;
        if (result.nextOffset === null) break;
        assert.ok(result.nextOffset > offset);
        offset = result.nextOffset;
      }
      assert.equal(actual, text);
      assert.equal(fx.views.statistics().verifiedObjects, 1);
      assert.equal((fx.views.statistics() as Record<string, number>).utf8ValidationPasses, 1);
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects unknown IDs, invalid ranges, links and changed cached objects", async () => {
    const fx = await fixture({ "outputs/result.txt": "Original exact result." });
    try {
      const id = fx.views.index.objects[0]!.objectId;
      for (const objectId of ["../../credentials.json", "a".repeat(64)]) {
        await assert.rejects(fx.views.read({ objectId }), {
          code: "RESEARCH_ARTIFACT_VIEW_INVALID",
        });
      }
      await assert.rejects(fx.views.read({ objectId: id, offset: -1 }), {
        code: "RESEARCH_ARTIFACT_VIEW_INVALID",
      });
      await assert.rejects(fx.views.read({ objectId: id, length: 0 }), {
        code: "RESEARCH_ARTIFACT_VIEW_INVALID",
      });
      await fx.views.read({ objectId: id });
      await writeFile(join(fx.project, "outputs/result.txt"), "Changed! exact result.");
      await assert.rejects(fx.views.read({ objectId: id }), {
        code: "RESEARCH_ARTIFACT_VIEW_DRIFT",
      });
      await rm(join(fx.project, "outputs/result.txt"));
      await writeFile(join(fx.root, "outside.txt"), "Original exact result.");
      await symlink(join(fx.root, "outside.txt"), join(fx.project, "outputs/result.txt"));
      await assert.rejects(fx.views.read({ objectId: id }), {
        code: "RESEARCH_ARTIFACT_VIEW_INVALID",
      });
    } finally {
      await fx.cleanup();
    }
  });

  it("does not expose credentials split across requested pages or encoded as base64", async () => {
    const secret = "private-fixture-token-987654321";
    const fx = await fixture({
      "outputs/unsafe.txt": `Safe prefix.\nAuthorization: Bearer ${secret}\n`,
    });
    try {
      for (const encoding of ["utf8", "base64"] as const) {
        await assert.rejects(
          fx.views.read({ objectId: fx.views.index.objects[0]!.objectId, length: 5, encoding }),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, "RESEARCH_ARTIFACT_VIEW_SENSITIVE");
            assert.equal(String(error).includes(secret), false);
            return true;
          },
        );
      }
      assert.equal(fx.views.receipts().length, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("reads binary bytes only by explicit encoding and stores actual read receipts by hash", async () => {
    const binary = Buffer.from([0, 255, 254, 1, 5, 8]);
    const fx = await fixture({ "inputs/binary.bin": binary });
    try {
      const id = fx.views.index.objects[0]!.objectId;
      await assert.rejects(fx.views.read({ objectId: id }), {
        code: "RESEARCH_ARTIFACT_VIEW_INVALID",
      });
      const read = await fx.views.read({ objectId: id, encoding: "base64", length: null });
      assert.deepEqual(Buffer.from(read.content, "base64"), binary);
      await persistArtifactReads(
        fx.permanent,
        fx.project,
        fx.binding,
        fx.packetSha256,
        fx.views.receipts(),
      );
      await persistArtifactReads(
        fx.permanent,
        fx.project,
        fx.binding,
        fx.packetSha256,
        fx.views.receipts(),
      );
      assert.deepEqual(
        await readFile(join(fx.permanent, "reads/objects", sha256Bytes(binary))),
        binary,
      );
      const saved = JSON.parse(
        await readFile(
          join(fx.permanent, "reads/receipts", `${read.receipt.receiptSha256}.json`),
          "utf8",
        ),
      );
      assert.deepEqual(saved, read.receipt);
      await assert.rejects(
        persistArtifactReads(fx.permanent, fx.project, fx.binding, sha256Text("other packet"), [
          read.receipt,
        ]),
        { code: "RESEARCH_ARTIFACT_VIEW_DRIFT" },
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses an altered directory and an aliased permanent audit destination", async () => {
    const fx = await fixture({ "outputs/readme.txt": "A safe research result." });
    try {
      const read = await fx.views.read({ objectId: fx.views.index.objects[0]!.objectId });
      const elsewhere = join(fx.root, "elsewhere");
      await mkdir(elsewhere);
      await symlink(elsewhere, join(fx.permanent, "reads"));
      await assert.rejects(
        persistArtifactReads(fx.permanent, fx.project, fx.binding, fx.packetSha256, [read.receipt]),
        { code: "RESEARCH_ARTIFACT_VIEW_INVALID" },
      );
      await chmod(join(fx.project, fx.binding.path), 0o600);
      await writeFile(join(fx.project, fx.binding.path), "{}");
      await assert.rejects(openArtifactViews(fx.project, fx.binding, fx.packetSha256), {
        code: "RESEARCH_ARTIFACT_VIEW_DRIFT",
      });
    } finally {
      await fx.cleanup();
    }
  });
});
