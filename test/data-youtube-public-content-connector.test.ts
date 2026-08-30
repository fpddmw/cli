import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { youtubePublicContentConnector } from "../src/data/connectors/youtube-public-content.js";
import {
  YOUTUBE_COMMENTS_INPUT_SCHEMA,
  YOUTUBE_VIDEO_SEARCH_INPUT_SCHEMA,
} from "../src/data/connectors/youtube-public-content.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";

function searchRequest(): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "youtube.public-content",
    capabilityVersion: "1.0.0",
    operationId: "search-videos",
    operationVersion: "1.0.0",
    input: {
      query: "climate policy",
      publishedAfter: "2026-03-01T00:00:00Z",
      publishedBefore: "2026-03-08T00:00:00Z",
      order: "date",
      regionCode: "US",
      relevanceLanguage: "en",
      safeSearch: "moderate",
      videoDuration: "medium",
      pageSize: 2,
      requirePublicComments: true,
      minimumCommentCount: 5,
      minimumViewCount: 100,
    },
  };
}

function commentsRequest(): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "youtube.public-content",
    capabilityVersion: "1.0.0",
    operationId: "fetch-comments",
    operationVersion: "1.0.0",
    input: {
      videoIds: ["video-1"],
      startDateTime: "2026-03-01T00:00:00Z",
      endDateTime: "2026-03-08T00:00:00Z",
      timeField: "published",
      includeReplies: true,
      order: "time",
      pageSize: 100,
    },
  };
}

describe("YouTube public-content connector", () => {
  it("documents all top-level inputs for both operations", () => {
    for (const schema of [YOUTUBE_VIDEO_SEARCH_INPUT_SCHEMA, YOUTUBE_COMMENTS_INPUT_SCHEMA]) {
      for (const [name, property] of Object.entries(schema.properties)) {
        assert.equal(typeof (property as Record<string, unknown>).description, "string", name);
        assert.ok(Array.isArray((property as Record<string, unknown>).examples), name);
      }
    }
  });

  it("injects the API key in a header, searches videos, and enriches details", async () => {
    const targets: URL[] = [];
    const headers: Headers[] = [];
    const result = await executeDataRun(searchRequest(), {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target, init) => {
        const url = new URL(String(target));
        targets.push(url);
        headers.push(new Headers(init?.headers));
        if (url.pathname.endsWith("/search")) {
          return Response.json({
            items: [
              {
                id: { kind: "youtube#video", videoId: "video-1" },
                snippet: {
                  publishedAt: "2026-03-04T00:00:00Z",
                  channelId: "channel-1",
                  title: "Climate video",
                  description: "Description",
                  channelTitle: "Example channel",
                  liveBroadcastContent: "none",
                },
              },
            ],
            pageInfo: { totalResults: 1, resultsPerPage: 2 },
          });
        }
        return Response.json({
          items: [
            {
              id: "video-1",
              snippet: {
                publishedAt: "2026-03-04T00:00:00Z",
                channelId: "channel-1",
                title: "Climate video",
                description: "Description",
                channelTitle: "Example channel",
                tags: ["climate"],
                categoryId: "28",
                defaultLanguage: "en",
                liveBroadcastContent: "none",
              },
              statistics: { viewCount: "250", likeCount: "12", commentCount: "8" },
              contentDetails: { duration: "PT4M2S", caption: "true", definition: "hd" },
              status: { privacyStatus: "public", embeddable: true, license: "youtube" },
            },
          ],
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.pageCount, 2);
    assert.equal(targets[0]?.searchParams.has("key"), false);
    assert.equal(headers[0]?.get("X-Goog-Api-Key"), "secret-youtube-key");
    assert.equal(targets[0]?.searchParams.get("q"), "climate policy");
    assert.equal(targets[1]?.searchParams.get("id"), "video-1");
    const records = (result.data as { records: Array<{ videoId: string; statistics: unknown }> })
      .records;
    assert.deepEqual(
      records.map((item) => item.videoId),
      ["video-1"],
    );
    assert.ok(records[0]?.statistics);
  });

  it("fetches complete reply pages rather than trusting embedded replies", async () => {
    const targets: URL[] = [];
    const result = await executeDataRun(commentsRequest(), {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        targets.push(url);
        if (url.pathname.endsWith("/commentThreads")) {
          return Response.json({
            items: [
              {
                id: "thread-1",
                snippet: {
                  videoId: "video-1",
                  totalReplyCount: 2,
                  topLevelComment: {
                    id: "comment-top",
                    snippet: {
                      videoId: "video-1",
                      textDisplay: "Top comment",
                      textOriginal: "Top comment",
                      authorDisplayName: "A",
                      authorChannelId: { value: "channel-a" },
                      canRate: true,
                      viewerRating: "none",
                      likeCount: 2,
                      publishedAt: "2026-03-03T00:00:00Z",
                      updatedAt: "2026-03-03T01:00:00Z",
                    },
                  },
                },
                replies: { comments: [{ id: "embedded-only" }] },
              },
            ],
          });
        }
        return Response.json({
          items: [
            {
              id: "reply-1",
              snippet: {
                parentId: "comment-top",
                textDisplay: "Reply one",
                textOriginal: "Reply one",
                authorDisplayName: "B",
                publishedAt: "2026-03-03T02:00:00Z",
                updatedAt: "2026-03-03T02:00:00Z",
                likeCount: 1,
              },
            },
            {
              id: "reply-2",
              snippet: {
                parentId: "comment-top",
                textDisplay: "Reply two",
                textOriginal: "Reply two",
                authorDisplayName: "C",
                publishedAt: "2026-03-03T03:00:00Z",
                updatedAt: "2026-03-03T03:00:00Z",
                likeCount: 0,
              },
            },
          ],
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 3);
    assert.equal(result.summary.pageCount, 2);
    assert.ok(targets[1]?.pathname.endsWith("/comments"));
    assert.equal(targets[1]?.searchParams.get("parentId"), "comment-top");
    const records = (result.data as { records: Array<{ commentId: string; kind: string }> })
      .records;
    assert.deepEqual(
      records.map((item) => item.commentId),
      ["comment-top", "reply-1", "reply-2"],
    );
  });

  it("blocks without the declared logical credential before network access", async () => {
    let fetched = false;
    const result = await executeDataRun(searchRequest(), {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: {},
      fetchImpl: (async () => {
        fetched = true;
        throw new Error("must not fetch");
      }) as typeof fetch,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "credential-missing");
    assert.equal(fetched, false);
  });

  it("rejects whitespace-only queries and normalized duplicate video IDs", async () => {
    let fetched = false;
    for (const request of [
      { ...searchRequest(), input: { query: "   " } },
      {
        ...commentsRequest(),
        input: { videoIds: ["video-1", " video-1 "] },
      },
    ]) {
      const result = await executeDataRun(request, {
        registry: createDataRegistry([youtubePublicContentConnector]),
        environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errors[0]?.code, "invalid-request");
    }
    assert.equal(fetched, false);
  });

  it("preserves comments from completed videos when a later video is disabled", async () => {
    const nextRequest = {
      ...commentsRequest(),
      input: {
        ...(commentsRequest().input as object),
        videoIds: ["video-1", "video-2"],
        includeReplies: false,
      },
    };
    const result = await executeDataRun(nextRequest, {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        if (url.searchParams.get("videoId") === "video-2") {
          return Response.json({ error: { message: "commentsDisabled" } }, { status: 403 });
        }
        return Response.json({
          items: [
            {
              id: "thread-1",
              snippet: {
                videoId: "video-1",
                totalReplyCount: 0,
                topLevelComment: {
                  id: "comment-top",
                  snippet: {
                    videoId: "video-1",
                    textDisplay: "Top comment",
                    authorDisplayName: "A",
                    publishedAt: "2026-03-03T00:00:00Z",
                    updatedAt: "2026-03-03T00:00:00Z",
                    likeCount: 0,
                  },
                },
              },
            },
          ],
        });
      }) as typeof fetch,
    });
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(result.summary.missing, [{ kind: "range", identifiers: ["video-2"] }]);
  });
});
