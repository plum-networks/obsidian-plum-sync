# Obsidian Plum Box Sync

Sync your Obsidian vault to **your own Plum Box** — no third-party cloud, no server that can read your notes.

You sign in on **plumbox.me** in your browser (like "Sign in with Google"), so **this plugin never sees your password** — only a scoped, revocable token. The notes live on hardware you own.

## How it works

1. **Connect** (Settings → Plum Box Sync → *Connect*). Your browser opens `plumbox.me`, you sign in and approve access. The box hands Obsidian back a scoped **read/write** token via a PKCE-protected redirect — the password is typed only on Plum's own page.
2. Your vault maps to a drive folder on the box (default `/Obsidian/<vault>`).
3. **Sync** copies changes both ways: uploads local edits, downloads remote edits, propagates deletions to the recoverable trash on each side, and keeps **both** copies when a file changed on both sides at once.

Sync runs when you click **Sync now** (ribbon or command palette), on a timer (default every 15 min), and a few seconds after you edit the vault.

## Deletion safety

A note missing on one side is deleted on the other only when the box's file list
is known to be complete and the surviving copy is exactly what was last synced.

- **Incomplete box listing** (the box answers `503 listing_incomplete`, or the
  pages don't add up): the sync stops before changing anything and a notice
  says why.
- **Mass deletion**: if one side would lose more than
  `max(10, min(50, 10% of synced files))` files in one sync, those deletions are
  paused and a dialog asks **Delete N files** or **Keep files** (re-upload /
  re-download). Everything else still syncs. Closing the dialog keeps them
  paused; run **Plum Box Sync: Review paused deletions** to decide later.
- **Edit vs delete**: an edit always wins; the edited copy is synced back.
- **Saved during a sync**: a note saved (or created) while its download is in
  flight is not overwritten — the next sync keeps both copies. A save made
  while its upload is in flight is uploaded by the next sync.
- **Hidden files** (`.obsidian/`, anything starting with `.`) and notes that
  cannot be read are left alone, never treated as deleted. The first sync waits
  until Obsidian has finished loading the vault.
- **Changing the remote folder or account** starts from a fresh baseline: that
  sync can upload, download or keep both copies, but not delete.

## Security

- The password is entered **only** on `plumbox.me`, in your system browser — never inside Obsidian. This plugin receives a token, not credentials.
- The token is **read/write only**; `admin` is never requested and the box refuses it. Revoke it any time in your box settings — sync stops working, your account is untouched.
- The token is stored in this plugin's `data.json` (plaintext at rest, like other sync plugins). Treat your vault device accordingly.
- Deletions go to a **recoverable trash** on both sides (Obsidian's `.trash` locally, the box trash remotely), not a hard delete.

## Install (manual, during development)

1. Build: `npm install && npm run build` (tests: `npm test`).
2. Copy `manifest.json`, `main.js`, `versions.json` into `<vault>/.obsidian/plugins/plum-sync/`.
3. Enable **Plum Box Sync** in Settings → Community plugins.

## Conflict handling

If a note changed on **both** the box and this device since the last sync, the plugin keeps both: your local version stays at the original name, and the box's version is written alongside as `note (conflict <date>).md`. Nothing is lost; you merge and delete the extra copy.

## Built on `@plumbox/client`

This plugin is a thin client over the [`@plumbox/client`](https://github.com/plum-networks/plum-sdk) SDK (delegated OAuth + Drive API), using Obsidian's `requestUrl` transport so it works on desktop **and** mobile without `isDesktopOnly`.

## License

MIT — see [LICENSE](./LICENSE).
