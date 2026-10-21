# Obsidian Plum Box Sync

Sync your Obsidian vault to **your own Plum Box** — no third-party cloud, no server that can read your notes.

You sign in through your browser (like "Sign in with Google"): **plumbox.me** finds your box, and you type your password only on **your box's own page**. So **this plugin never sees your password** — only a scoped, revocable token that reaches **one folder the box gives the plugin**, not the rest of your drive. The notes live on hardware you own.

## How it works

1. **Connect** (Settings → Plum Box Sync → *Connect*). Your browser opens `plumbox.me`: enter your email and the code Plum mails you, and pick your box. You then sign in on that box's own page (`https://pb-….plumbox.me`) and approve access. The box hands Obsidian back a scoped token via a PKCE-protected redirect. plumbox.me never asks for your password; only your box does.
2. Your vault maps to a folder in the plugin's own folder on the box: `/Apps/Obsidian Sync/<vault>` (the box names the folder and creates it when you approve).
3. **Sync** copies changes both ways: uploads local edits, downloads remote edits, propagates deletions to the recoverable trash on each side, and keeps **both** copies when a file changed on both sides at once.

Sync runs when you click **Sync now** (ribbon or command palette), on a timer (default every 15 min), and a few seconds after you edit the vault.

## Connections: per device, refreshed every hour

- **Each device connects once.** The connection is kept in Obsidian's per-vault local storage on that device (Obsidian 1.8.7+), not in the plugin's `data.json`. `data.json` sits in the vault's `.obsidian` folder, which many people sync between devices, and the connection's refresh token changes every time it is used: two devices using one would end the connection for both. On Obsidian older than 1.8.7 there is no such storage and the connection falls back to `data.json` — update Obsidian if you sync `.obsidian`.
- **Access tokens last an hour.** The plugin trades its refresh token for a new pair by itself, once for all the requests a sync makes at the same time, and saves the new pair straight away. A connection not used for **90 days** lapses, and one you remove in your box settings ends: the plugin then says so and asks you to connect again. A "not allowed" answer from the box (403) is reported as a failed sync, not as a lost connection.
- **The plugin's own folder.** The plugin asks for `files:app` (its own folder, which the box creates and names, e.g. `/Apps/Obsidian Sync`) and `user:profile` (the account name the settings show). The vault syncs to `<that folder>/<vault>`; the remote-folder setting is shown, not editable, for such a connection.
- **Upgrading from 0.2.** A connection 0.2 made (a token that never expires, stored in `data.json`, reaching the whole drive and syncing to `/Obsidian/<vault>`) keeps working as it is. *Connect again* in settings replaces it with this device's own connection; the vault then syncs to the plugin's folder, starting fresh there (everything is compared and copied, nothing is deleted), and your other devices connect once each. The old `/Obsidian/<vault>` folder stays on the box untouched; remove the old token in your box settings if you like.

## Security

- The password is entered **only** on your box's own page (`https://pb-….plumbox.me`), in your system browser — never inside Obsidian, and never on plumbox.me. This plugin receives a token, not credentials.
- The plugin trades the sign-in code for its token only with the box the redirect names, and only when that is a Plum box's own address (`https://pb-….plumbox.me`) and the sign-in is the one it started. Anything else stops before the code is sent anywhere, and the token is only ever sent to that box.
- The token reaches **only the plugin's own folder** (`files:app`) and your account name (`user:profile`); `admin` is never requested and the box refuses it. Revoke it any time in your box settings — sync stops working, your account is untouched.
- The tokens are stored on the device, in Obsidian's local storage for this vault (plaintext at rest, like other sync plugins). Treat your vault device accordingly.
- Deletions go to a **recoverable trash** on both sides (Obsidian's `.trash` locally, the box trash remotely), not a hard delete.

## Install (manual, during development)

1. Build: `npm install && npm run build`. Tests: `npm test`.
2. Copy `manifest.json`, `main.js`, `versions.json` into `<vault>/.obsidian/plugins/plum-sync/`.
3. Enable **Plum Box Sync** in Settings → Community plugins.

The box consents only to a registered client: this plugin is
`im.plum.obsidian-sync:obsidian`, registered in the Plum store with the
redirect `obsidian://plum-sync`. It asks for `files:app user:profile`, so
**before this version is released the registration's `scopes_allowed` must
list `files:app`** (and `user:profile`); otherwise the box refuses the
sign-in. A box from before the app-folder scope refuses it too (`invalid_scope`):
the plugin then says the box needs an update.

## Conflict handling

If a note changed on **both** the box and this device since the last sync, the plugin keeps both: your local version stays at the original name, and the box's version is written alongside as `note (conflict <date>).md`. Nothing is lost; you merge and delete the extra copy.

## Built on `@plumbox/client`

This plugin is a thin client over the [`@plumbox/client`](https://github.com/plum-networks/plum-sdk) SDK (delegated OAuth + Drive API), using Obsidian's `requestUrl` transport so it works on desktop **and** mobile without `isDesktopOnly`. The SDK's build is vendored in `vendor/plumbox-client` (0.4.0: it checks the redirect's `iss` and `state`, refreshes the hourly tokens, and tells a 403 from a lost connection); to update it, build `packages/client` in plum-sdk and copy its `dist/`, `package.json` and `README.md` there.

## License

MIT — see [LICENSE](./LICENSE).
