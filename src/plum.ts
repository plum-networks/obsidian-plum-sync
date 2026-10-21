import { requestUrl, Notice } from "obsidian";
import { injectedAdapter, type PlumAuthError } from "@plumbox/client";
import { beginConnect, finishConnect } from "./connect.js";
import { connectionFromTokens, mayReadProfile, type ActiveConnection } from "./connection.js";
import type PlumSyncPlugin from "./main.js";

/** Obsidian's requestUrl: bypasses CORS on desktop and mobile. */
export const http = injectedAdapter(requestUrl);

/**
 * Delegated ("Sign in with Plum") authorization. The password is NEVER typed in
 * Obsidian: the system browser opens plumbox.me, where the user finds their box
 * with their email and a code Plum mails them; they type the password only on
 * that box's own page and approve there. The box deep-links back with a code
 * we trade — via PKCE — for a scoped token. See RFC 8252.
 */
export async function startConnect(plugin: PlumSyncPlugin): Promise<void> {
  const { url, pending } = await beginConnect();
  // Keep the verifier + state until the deep-link returns.
  plugin.settings.pending = pending;
  await plugin.saveSettings();

  // Open in the SYSTEM BROWSER, never an in-app webview — the user must see the
  // real plumbox.me, and then their box's own address, in the address bar.
  // Obsidian routes external URLs to the OS browser on desktop and mobile alike.
  window.open(url, "_blank");
  new Notice("Opened plumbox.me. Find your Plum Box, sign in on its page and allow access, then come back to Obsidian.");
}

/**
 * Handle the obsidian://plum-sync?code=&iss=&state= deep link fired after the
 * user approves on their box. The code goes only to the box a checked `iss`
 * names, and only for the sign-in started here; the tokens are then kept as
 * this device's connection. Returns true on success.
 */
export async function completeConnect(
  plugin: PlumSyncPlugin,
  params: Record<string, unknown>,
): Promise<boolean> {
  const pending = plugin.settings.pending;
  plugin.settings.pending = null; // one-shot, whatever happens

  const outcome = await finishConnect(pending, params, http);
  if (outcome.kind === "stopped") {
    switch (outcome.reason) {
      case "no_pending":
        new Notice("Plum: no sign-in was in progress. Try Connect again.");
        break;
      case "invalid_iss":
        new Notice("Plum: this sign-in did not come from a Plum Box, so it was stopped. Nothing was sent. Try Connect again.");
        break;
      case "invalid_state":
        new Notice("Plum: this is not the sign-in you started here, so it was stopped. Try Connect again.");
        break;
      case "invalid_scope":
        new Notice("Plum: your box does not offer this plugin its own folder yet. Update your Plum Box, then connect again.");
        break;
      case "cancelled":
        new Notice(`Plum: sign-in was cancelled${outcome.detail ? ` (${outcome.detail})` : ""}.`);
        break;
      default:
        new Notice(`Plum: could not complete sign-in — ${outcome.detail ?? "please try again"}`);
    }
    await plugin.saveSettings();
    return false;
  }

  const conn = connectionFromTokens(outcome.iss, outcome.tokens);
  await plugin.setConnection(conn);
  await plugin.saveSettings();
  // Best-effort: record which account this is, for the settings display.
  // Only when the box granted user:profile — otherwise it would answer 403.
  if (mayReadProfile(conn)) {
    try {
      const me = await plugin.getClient()!.auth.me();
      await plugin.updateAccount(conn.id, me.email ?? me.username ?? "");
    } catch {
      /* non-fatal — the token still works for drive */
    }
  }
  new Notice("Connected to your Plum Box.");
  return true;
}

/**
 * The box no longer takes this connection: the refresh was refused (it was
 * disconnected in box settings, or not used for 90 days) or a token without
 * a refresh token was rejected. Called once per connection by the SDK —
 * never for a 403, which only means "not allowed".
 */
export async function connectionEnded(plugin: PlumSyncPlugin, conn: ActiveConnection, err: PlumAuthError): Promise<void> {
  console.warn("plum-sync: the box ended the connection", err);
  const dropped = await plugin.dropConnection(conn);
  if (dropped) {
    new Notice(
      "Plum: your box no longer accepts this device's connection (it was revoked, or not used for 90 days). Connect again in settings.",
    );
  }
}

export function isConnected(plugin: PlumSyncPlugin): boolean {
  return plugin.connection() !== null;
}
