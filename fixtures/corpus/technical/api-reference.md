---
title: Widget API Reference
version: 2.3.0
status: stable
---

# Widget API Reference

A representative technical document: front matter, headings, tables, multiple
fenced code languages, inline code, blockquotes, and nested lists. Original
content, released CC0.

## Endpoints

| Method | Path             | Auth   | Description                     |
|--------|------------------|--------|---------------------------------|
| `GET`  | `/widgets`       | none   | List all widgets.               |
| `GET`  | `/widgets/{id}`  | none   | Fetch a single widget by id.    |
| `POST` | `/widgets`       | bearer | Create a widget.                |
| `PATCH`| `/widgets/{id}`  | bearer | Partially update a widget.      |
| `DELETE`| `/widgets/{id}` | bearer | Delete a widget (idempotent).   |

## Request example

```bash
curl -sS https://api.example.com/widgets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "gadget", "count": 3}'
```

## Response schema

```json
{
  "id": "w_01H",
  "name": "gadget",
  "count": 3,
  "created_at": "2026-07-09T00:00:00Z",
  "tags": ["a", "b"]
}
```

## Types

```typescript
interface Widget {
  id: string;
  name: string;
  count: number;
  createdAt: string; // ISO 8601
  tags: string[];
}
```

## Errors

> **Note:** all error responses share the same envelope.

- `400` — validation failed
  - the `detail` field enumerates each offending path
- `401` — missing or invalid bearer token
- `404` — no widget with that id
- `429` — rate limited; honor the `Retry-After` header

## Notes

Inline references such as the `count` field and the `/widgets/{id}` route appear
throughout prose, which is exactly the pattern anchors must survive.
