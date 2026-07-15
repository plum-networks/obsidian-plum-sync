import { requestUrl, Notice } from "obsidian";
import {
  PlumClient,
  injectedAdapter,
  beginAuthorization,
  exchangeCode,
  type CallbackResult,
} from "@plumbox/client";
import { CLIENT_ID, CLIENT_NAME, REDIRECT_URI } from "./types.js";
import type PlumSyncPlugin from "./main.js";

/**
 * Delegated ("Sign in with Plum") authorization. The password is NEVER typed in
 * Obsidian: we open plumbox.me in the system browser, the user signs in and
 * approves there, and the box deep-links back with a code we trade — via PKCE —
 * for a scoped token. See RFC 8252.
 */
export async function startConnect(plugin: PlumSyncPlugin): Promise<void> {
  const req = await beginAuthorization({
    clientId: CLIENT_ID,
    clientName: CLIENT_NAME,
    redirectUri: REDIRECT_URI,
    scopes: ["read", "write"], // never "admin"
  });
  // Keep the verifier + state until the deep-link returns.
  plugin.settings.pending = { verifier: req.codeVerifier, state: req.state };
  await plugin.saveSettings();

  // Open in the SYSTEM BROWSER, never an in-app webview — the user must see the
  // real plumbox.me address bar. Obsidian routes external URLs to the OS browser
  // on desktop and mobile alike.
  window.open(req.url, "_blank");
  new Notice("Opened plumbox.me to sign in. Approve access, then return to Obsidian.");
}

/**
 * Handle the obsidian://plum-sync?code=&iss=&state= deep link fired after the
 * user approves on plumbox.me. Verifies state, exchanges the code for a token,
 * and persists {baseUrl, token}. Returns true on success.
 */
export async function completeConnect(
  plugin: PlumSyncPlugin,
  params: CallbackResult,
): Promise<boolean> {
  const pending = plugin.settings.pending;
  plugin.settings.pending = null; // one-shot, whatever happens

  if (!pending) {
    new Notice("Plum: no sign-in was in progress. Try Connect again.");
    await plugin.saveSettings();
    return false;
  }
  if (params.state !== pending.state) {
    new Notice("Plum: sign-in could not be verified (state mismatch). Try again.");
    await plugin.saveSettings();
    return false;
  }
  if (params.error || !params.code || !params.iss) {
    new Notice(`Plum: sign-in was cancelled${params.error ? ` (${params.error})` : ""}.`);
    await plugin.saveSettings();
    return false;
  }

  try {
    const { accessToken } = await exchangeCode({
      baseUrl: params.iss,
      code: params.code,
      codeVerifier: pending.verifier,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      http: injectedAdapter(requestUrl),
    });
    plugin.settings.baseUrl = params.iss;
    plugin.settings.token = accessToken;

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
  } catch (e) {
    new Notice(`Plum: could not complete sign-in — ${(e as Error).message}`);
    await plugin.saveSettings();
    return false;
  }
}

/** Build a PlumClient from stored credentials, or null if not connected. */
export function buildClient(plugin: PlumSyncPlugin): PlumClient | null {
  const { baseUrl, token } = plugin.settings;
  if (!baseUrl || !token) return null;
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
  return !!plugin.settings.baseUrl && !!plugin.settings.token;
}
