# Obsidian Plum Box Sync

Sync your Obsidian vault to **your own Plum Box** — no third-party cloud, no server that can read your notes.

You sign in through your browser (like "Sign in with Google"): **plumbox.me** finds your box, and you type your password only on **your box's own page**. So **this plugin never sees your password** — only a scoped, revocable token. The notes live on hardware you own.

## How it works

1. **Connect** (Settings → Plum Box Sync → *Connect*). Your browser opens `plumbox.me`: enter your email and the code Plum mails you, and pick your box. You then sign in on that box's own page (`https://pb-….plumbox.me`) and approve access. The box hands Obsidian back a scoped **read/write** token via a PKCE-protected redirect. plumbox.me never asks for your password; only your box does.
2. Your vault maps to a drive folder on the box (default `/Obsidian/<vault>`).
3. **Sync** copies changes both ways: uploads local edits, downloads remote edits, propagates deletions to the recoverable trash on each side, and keeps **both** copies when a file changed on both sides at once.

Sync runs when you click **Sync now** (ribbon or command palette), on a timer (default every 15 min), and a few seconds after you edit the vault.

## Security

- The password is entered **only** on your box's own page (`https://pb-….plumbox.me`), in your system browser — never inside Obsidian, and never on plumbox.me. This plugin receives a token, not credentials.
- The plugin trades the sign-in code for its token only with the box the redirect names, and only when that is a Plum box's own address (`https://pb-….plumbox.me`) and the sign-in is the one it started. Anything else stops before the code is sent anywhere, and the token is only ever sent to that box.
- The token is **read/write only**; `admin` is never requested and the box refuses it. Revoke it any time in your box settings — sync stops working, your account is untouched.
- The token is stored in this plugin's `data.json` (plaintext at rest, like other sync plugins). Treat your vault device accordingly.
- Deletions go to a **recoverable trash** on both sides (Obsidian's `.trash` locally, the box trash remotely), not a hard delete.

## Install (manual, during development)

1. Build: `npm install && npm run build`. Tests: `npm test`.
2. Copy `manifest.json`, `main.js`, `versions.json` into `<vault>/.obsidian/plugins/plum-sync/`.
3. Enable **Plum Box Sync** in Settings → Community plugins.

The box consents only to a registered client: this plugin is
`im.plum.obsidian-sync:obsidian`, registered in the Plum store with the
redirect `obsidian://plum-sync` and the scopes `files:read files:write`.

## Conflict handling

If a note changed on **both** the box and this device since the last sync, the plugin keeps both: your local version stays at the original name, and the box's version is written alongside as `note (conflict <date>).md`. Nothing is lost; you merge and delete the extra copy.

## Built on `@plumbox/client`

This plugin is a thin client over the [`@plumbox/client`](https://github.com/plum-networks/plum-sdk) SDK (delegated OAuth + Drive API), using Obsidian's `requestUrl` transport so it works on desktop **and** mobile without `isDesktopOnly`. The SDK's build is vendored in `vendor/plumbox-client` (0.3.0, which checks the redirect's `iss` and `state`); to update it, build `packages/client` in plum-sdk and copy its `dist/`, `package.json` and `README.md` there.

## License

MIT — see [LICENSE](./LICENSE).
