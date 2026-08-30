# Synthetic YouTube fixtures

The YouTube connector tests construct small JSON objects in memory that follow the
documented YouTube Data API v3 `search.list`, `videos.list`,
`commentThreads.list`, and `comments.list` response shapes. All IDs, channels,
authors, text, timestamps, and statistics are invented.

Reviewed specifications:

- https://developers.google.com/youtube/v3/docs/search/list
- https://developers.google.com/youtube/v3/docs/videos/list
- https://developers.google.com/youtube/v3/docs/commentThreads/list
- https://developers.google.com/youtube/v3/docs/comments/list
