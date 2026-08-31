import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { blueskyPublicPostsConnector } from "../src/data/connectors/bluesky-public-posts.js";
import { BLUESKY_CASCADE_INPUT_SCHEMA } from "../src/data/connectors/bluesky-public-posts.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";

function request(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "bluesky.public-posts",
    capabilityVersion: "1.0.0",
    operationId: "fetch-cascades",
    operationVersion: "1.0.0",
    input: {
      source: {
        mode: "search",
        query: "climate policy",
        sort: "latest",
        author: "example.test",
        language: "en",
        tags: ["climate"],
      },
      startDateTime: "2026-03-10T00:00:00Z",
      endDateTime: "2026-03-11T00:00:00Z",
      pageSize: 2,
      expandThreads: true,
      maxThreads: 1,
      threadDepth: 4,
      threadParentHeight: 2,
      ...inputOverrides,
    },
  };
}

function post(uri: string, text: string, createdAt: string) {
  return {
    uri,
    cid: `cid-${uri.slice(-1)}`,
    author: { did: "did:plc:alice", handle: "alice.test", displayName: "Alice" },
    record: {
      $type: "app.bsky.feed.post",
      text,
      createdAt,
      langs: ["en"],
    },
    indexedAt: createdAt,
    replyCount: 1,
    repostCount: 2,
    likeCount: 3,
    quoteCount: 0,
  };
}

describe("Bluesky public-post cascades connector", () => {
  it("documents every agent-facing input field", () => {
    for (const [name, schema] of Object.entries(BLUESKY_CASCADE_INPUT_SCHEMA.properties)) {
      assert.equal(typeof (schema as Record<string, unknown>).description, "string", name);
      assert.ok(Array.isArray((schema as Record<string, unknown>).examples), name);
    }
  });

  it("searches a bounded UTC window and flattens a reply cascade", async () => {
    const targets: URL[] = [];
    const rootUri = "at://did:plc:alice/app.bsky.feed.post/1";
    const replyUri = "at://did:plc:bob/app.bsky.feed.post/2";
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([blueskyPublicPostsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        targets.push(url);
        if (url.pathname.endsWith("searchPosts")) {
          return Response.json({
            posts: [post(rootUri, "root", "2026-03-10T04:00:00Z")],
          });
        }
        return Response.json({
          thread: {
            $type: "app.bsky.feed.defs#threadViewPost",
            post: post(rootUri, "root", "2026-03-10T04:00:00Z"),
            replies: [
              {
                $type: "app.bsky.feed.defs#threadViewPost",
                post: post(replyUri, "reply", "2026-03-10T05:00:00Z"),
                replies: [],
              },
            ],
          },
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.pageCount, 2);
    assert.equal(result.summary.recordCount, 3);
    assert.equal(targets[0]?.origin, "https://public.api.bsky.app");
    assert.equal(targets[0]?.searchParams.get("q"), "climate policy");
    assert.equal(targets[0]?.searchParams.get("since"), "2026-03-10T00:00:00.000Z");
    assert.equal(targets[0]?.searchParams.get("until"), "2026-03-11T00:00:00.000Z");
    assert.deepEqual(targets[0]?.searchParams.getAll("tag"), ["climate"]);
    assert.equal(targets[1]?.searchParams.get("uri"), rootUri);
    const data = result.data as {
      seedPosts: Array<{ uri: string }>;
      cascades: Array<{ nodes: Array<{ uri: string; parentUri: string | null; depth: number }> }>;
      stopReason: string;
    };
    assert.deepEqual(
      data.seedPosts.map((item) => item.uri),
      [rootUri],
    );
    assert.deepEqual(
      data.cascades[0]?.nodes.map(({ uri, parentUri, depth }) => ({ uri, parentUri, depth })),
      [
        { uri: rootUri, parentUri: null, depth: 0 },
        { uri: replyUri, parentUri: rootUri, depth: 1 },
      ],
    );
    assert.equal(data.stopReason, "completed");
  });

  it("supports author, custom-feed, and list-feed sources without authentication", async () => {
    const cases = [
      [
        { mode: "author-feed", actor: "alice.test", filter: "posts_no_replies", includePins: true },
        "getAuthorFeed",
        "actor",
      ],
      [
        { mode: "feed", feedUri: "at://did:plc:alice/app.bsky.feed.generator/news" },
        "getFeed",
        "feed",
      ],
      [
        { mode: "list-feed", listUri: "at://did:plc:alice/app.bsky.graph.list/news" },
        "getListFeed",
        "list",
      ],
    ] as const;
    for (const [source, route, selector] of cases) {
      let requested: URL | undefined;
      const result = await executeDataRun(request({ source, expandThreads: false }), {
        registry: createDataRegistry([blueskyPublicPostsConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          requested = new URL(String(target));
          return Response.json({ feed: [] });
        }) as typeof fetch,
      });
      assert.equal(result.status, "success");
      assert.ok(requested?.pathname.endsWith(route));
      assert.ok(requested?.searchParams.has(selector));
    }
  });

  it("retries a route-level 403 through the documented public fallback host", async () => {
    const targets: URL[] = [];
    const result = await executeDataRun(request({ expandThreads: false }), {
      registry: createDataRegistry([blueskyPublicPostsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        targets.push(url);
        return url.origin === "https://public.api.bsky.app"
          ? new Response("forbidden", { status: 403 })
          : Response.json({ posts: [] });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.deepEqual(
      targets.map((target) => target.origin),
      ["https://public.api.bsky.app", "https://api.bsky.app"],
    );
    assert.equal((result.data as { source: { fallbackUsed: boolean } }).source.fallbackUsed, true);
  });

  it("supports a historical search diagnostic without weakening client-side time filtering", async () => {
    let target: URL | undefined;
    const result = await executeDataRun(
      request({
        source: {
          mode: "search",
          query: "historical event",
          applyServerTimeFilter: false,
        },
        expandThreads: false,
      }),
      {
        registry: createDataRegistry([blueskyPublicPostsConnector]),
        environment: {},
        fetchImpl: (async (value) => {
          target = new URL(String(value));
          return Response.json({
            hitsTotal: 42,
            posts: [
              post("at://did:plc:alice/app.bsky.feed.post/1", "inside", "2026-03-10T04:00:00Z"),
              post("at://did:plc:alice/app.bsky.feed.post/2", "outside", "2026-04-10T04:00:00Z"),
            ],
          });
        }) as typeof fetch,
      },
    );

    assert.equal(target?.searchParams.has("since"), false);
    assert.equal(target?.searchParams.has("until"), false);
    const data = result.data as { hitsTotal: number | null; seedPosts: Array<{ text: string }> };
    assert.equal(data.hitsTotal, 42);
    assert.deepEqual(data.seedPosts.map((item) => item.text), ["inside"]);
  });

  it("isolates malformed seeds and thread nodes while retaining valid public content", async () => {
    const rootUri = "at://did:plc:alice/app.bsky.feed.post/1";
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([blueskyPublicPostsConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        if (String(target).includes("searchPosts")) {
          return Response.json({
            posts: [
              null,
              { record: { text: "missing URI" } },
              { uri: rootUri, indexedAt: "2026-03-10T04:00:00Z" },
            ],
          });
        }
        return Response.json({
          thread: {
            $type: "app.bsky.feed.defs#threadViewPost",
            post: { uri: rootUri, indexedAt: "2026-03-10T04:00:00Z" },
            replies: [
              null,
              { $type: "app.bsky.feed.defs#unknown" },
              { $type: "app.bsky.feed.defs#blockedPost" },
            ],
          },
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    const data = result.data as {
      pages: Array<{ invalidRecords: number }>;
      seedPosts: Array<{ author: { did: string | null; handle: string | null } }>;
      cascades: Array<{
        nodes: Array<{ state: string; uri: string | null }>;
        validation: { missingNodeCount: number; issues: string[] };
      }>;
    };
    assert.equal(data.pages[0]?.invalidRecords, 2);
    assert.deepEqual(data.seedPosts[0]?.author, {
      did: null,
      handle: null,
      displayName: null,
    });
    assert.deepEqual(
      data.cascades[0]?.nodes.map(({ state, uri }) => ({ state, uri })),
      [
        { state: "post", uri: rootUri },
        { state: "blocked", uri: null },
      ],
    );
    assert.equal(data.cascades[0]?.validation.missingNodeCount, 1);
    assert.equal(data.cascades[0]?.validation.issues.length, 2);
  });

  it("preserves seeds when one thread expansion fails", async () => {
    const rootUri = "at://did:plc:alice/app.bsky.feed.post/1";
    const result = await executeDataRun(request(), {
      registry: createDataRegistry([blueskyPublicPostsConnector]),
      environment: {},
      fetchImpl: (async (target) =>
        String(target).includes("searchPosts")
          ? Response.json({ posts: [post(rootUri, "root", "2026-03-10T04:00:00Z")] })
          : new Response("missing", { status: 404 })) as typeof fetch,
    });
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.errors[0]?.code, "partial-result");
    assert.deepEqual(result.summary.missing, [{ kind: "range", identifiers: [rootUri] }]);
  });

  it("counts failed thread requests against the operation-wide request limit", async () => {
    const first = "at://did:plc:alice/app.bsky.feed.post/1";
    const second = "at://did:plc:alice/app.bsky.feed.post/2";
    let requests = 0;
    const result = await executeDataRun(
      { ...request({ maxThreads: 2 }), limits: { maxPages: 2 } },
      {
        registry: createDataRegistry([blueskyPublicPostsConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          requests += 1;
          if (String(target).includes("searchPosts")) {
            return Response.json({
              posts: [
                post(first, "first", "2026-03-10T04:00:00Z"),
                post(second, "second", "2026-03-10T05:00:00Z"),
              ],
            });
          }
          return new Response("missing", { status: 404 });
        }) as typeof fetch,
      },
    );
    assert.equal(requests, 2);
    assert.equal(result.status, "partial");
    assert.deepEqual(
      (result.data as { failures: Array<{ seedUri: string }> }).failures.map(
        (failure) => failure.seedUri,
      ),
      [first],
    );
  });

  it("rejects reversed time windows before network access", async () => {
    let fetched = false;
    const result = await executeDataRun(request({ startDateTime: "2026-03-12T00:00:00Z" }), {
      registry: createDataRegistry([blueskyPublicPostsConnector]),
      environment: {},
      fetchImpl: (async () => {
        fetched = true;
        throw new Error("must not fetch");
      }) as typeof fetch,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "invalid-request");
    assert.equal(fetched, false);
  });
});
