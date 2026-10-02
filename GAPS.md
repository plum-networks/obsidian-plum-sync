# SDK / box gaps found while building this plugin

Dogfooding notes for `@plumbox/client` and the box Drive/OAuth API. Each item is
something the plugin had to work around; they feed the next SDK / box milestone.
None blocked the MVP.

## Worked well (no gap)

- **Delegated OAuth** (`beginAuthorization` / `exchangeCode` / `parseCallback`)
  was sufficient end to end. The `iss` param carrying the box origin removed the
  need for the plugin to know the box address — exactly right.
- **Drive API** `listAll({recursive, hash})`, `upload({overwrite})`, `download`,
  `ensureDir`, `remove` covered the whole sync engine. Content `hash` as the
  sync key (matching the box's `content_hash`) is the feature that makes a clean
  diff possible.
- `injectedAdapter(requestUrl)` — one line, worked on the first try.

## Gaps (next SDK / box milestone)

1. **No change feed / delta cursor.** Every sync does a full recursive `listAll`
   + local walk + hash. Fine for typical vaults, O(n) per sync. A
   `GET /api/drive/changes?since=<cursor>` would make large vaults cheap.
   → highest-value follow-up.
2. **`parseCallback` takes a URL string only.** Obsidian's protocol handler
   delivers params as an object, so the plugin rebuilds a query string just to
   parse it back. A `parseCallbackParams(record)` overload would be tidier.
3. **Legacy remote files without a `hash`.** When `hash` is absent (file indexed
   before hashing, or written by another tool), the engine can't do an exact
   compare and falls back to "treat as changed". A box-side backfill of
   `content_hash`, or a `download`-and-hash helper, would remove the ambiguity.
4. **No `mtime` preservation on upload.** The box stamps its own modified time,
   so local mtime is informational only; the plugin relies on the hash instead.
   An optional `mtime` on `upload` would let clients preserve timestamps.
5. **No batch operations.** Deleting/moving many files is one request each. A
   batch `remove`/`move` would cut round-trips on large reorganizations.
6. **`onProgress` exists for upload but not download.** Large attachment
   downloads can't show progress.
7. **`listAll` can end early without saying so.** It stops on the first empty
   page even when `offset < total`, and offset paging over a tree that changes
   between pages can skip entries. A sync client treats a skipped entry as
   deleted, so the plugin pages `list` itself and checks the pages add up to
   `total` (`src/sync/remoteList.ts`). A snapshot/cursor for recursive listings
   would make this exact.
8. **No conditional delete.** `remove(path)` cannot say "only if the content
   hash is still X", so a remote edit that lands between listing and delete is
   moved to the box trash (recoverable, but not what the user meant). An
   `If-Match: <hash>` on delete (and on overwrite upload) would close this.

## Deferred by design (v1)

- 3-way merge of note contents — v1 keeps both copies on conflict (no text merge).
- Selective sync / ignore globs beyond Obsidian's own `.obsidian` exclusion.
- Real-time sync (websocket) — v1 is poll + on-change debounce.
