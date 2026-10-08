import { requestUrl, Notice } from "obsidian";
import { PlumClient, injectedAdapter, isPlumIssuer } from "@plumbox/client";
import { beginConnect, finishConnect } from "./connect.js";
import type PlumSyncPlugin from "./main.js";

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
 * names, and only for the sign-in started here; then {baseUrl, token} is
 * saved. Returns true on success.
 */
export async function completeConnect(
  plugin: PlumSyncPlugin,
  params: Record<string, unknown>,
): Promise<boolean> {
  const pending = plugin.settings.pending;
  plugin.settings.pending = null; // one-shot, whatever happens

  const outcome = await finishConnect(pending, params, injectedAdapter(requestUrl));
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
      case "cancelled":
        new Notice(`Plum: sign-in was cancelled${outcome.detail ? ` (${outcome.detail})` : ""}.`);
        break;
      default:
        new Notice(`Plum: could not complete sign-in — ${outcome.detail ?? "please try again"}`);
    }
    await plugin.saveSettings();
    return false;
  }

  plugin.settings.baseUrl = outcome.baseUrl;
  plugin.settings.token = outcome.token;
  // Best-effort: record which account this is, for the settings display.
  try {
    const me = await buildClient(plugin)!.auth.me();
    plugin.settings.account = me.email ?? me.username ?? "";
  } catch {
    /* non-fatal — the token still works for drive */
  }
  await plugin.saveSettings();
  new Notice("Connected to your Plum Box.");
  return true;
}

/** Build a PlumClient from stored credentials, or null if not connected. */
export function buildClient(plugin: PlumSyncPlugin): PlumClient | null {
  const { baseUrl, token } = plugin.settings;
  // The token goes only to a Plum box's own address (see forgetUncheckedBox).
  if (!token || !isPlumIssuer(baseUrl)) return null;
  return new PlumClient({
    baseUrl,
    token,
    http: injectedAdapter(requestUrl),
    onAuthError: () => {
      // Token revoked/expired: drop it so the UI prompts a reconnect.
      plugin.settings.token = "";
      plugin.settings.account = "";
      void plugin.saveSettings();
      new Notice("Plum: access was revoked. Reconnect from settings.");
    },
  });
}

export function isConnected(plugin: PlumSyncPlugin): boolean {
  return !!plugin.settings.token && isPlumIssuer(plugin.settings.baseUrl);
}
