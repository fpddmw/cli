# Synthetic Bluesky fixtures

The Bluesky connector tests construct small JSON objects in memory from the public
`app.bsky.feed` Lexicon shapes. They contain invented DIDs, handles, AT-URIs, text,
timestamps, and counters; no live user content is retained.

Reviewed specifications:

- https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/searchPosts.json
- https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getPostThread.json
- https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getAuthorFeed.json
- https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getFeed.json
- https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getListFeed.json
