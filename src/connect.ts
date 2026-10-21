// The sign-in steps that do not touch Obsidian, so they can be tested without
// it. plum.ts wires them to the settings, the notices and the browser.
import {
  beginAuthorization,
  callbackFromParams,
  exchangeCode,
  isPlumIssuer,
  PlumOAuthError,
  type HttpAdapter,
  type OAuthTokens,
} from "@plumbox/client";
import { CLIENT_ID, CLIENT_NAME, REDIRECT_URI, SCOPES, type PlumSyncSettings } from "./types.js";

/** What has to survive until the browser sends the user back. */
export interface PendingSignIn {
  verifier: string;
  state: string;
}

/** Where to send the browser, and what to keep until it comes back. */
export async function beginConnect(): Promise<{ url: string; pending: PendingSignIn }> {
  const req = await beginAuthorization({
    clientId: CLIENT_ID,
    clientName: CLIENT_NAME,
    redirectUri: REDIRECT_URI,
    scopes: [...SCOPES],
  });
  return { url: req.url, pending: { verifier: req.codeVerifier, state: req.state } };
}

export type ConnectOutcome =
  /** `iss`: the checked box. `tokens`: everything the box returned — keep it all. */
  | { kind: "connected"; iss: string; tokens: OAuthTokens }
  | {
      kind: "stopped";
      /**
       * no_pending: no sign-in was started here. cancelled: the box said no,
       * or the user did. invalid_scope: the box does not know a scope we ask
       * for (files:app came with a box update). invalid_iss: the link did not
       * come from a Plum box. invalid_state: it is not the sign-in this plugin
       * started. failed: the box refused the exchange or could not be reached.
       */
      reason: "no_pending" | "cancelled" | "invalid_scope" | "invalid_iss" | "invalid_state" | "failed";
      detail?: string;
    };

/**
 * Finish a sign-in from the obsidian://plum-sync?code=…&state=…&iss=… link.
 * The code is exchanged only at the box named by a checked `iss` (a Plum box's
 * own address, v3 contract 10.1), and only for the sign-in this plugin started
 * (`state`); otherwise nothing is sent anywhere.
 */
export async function finishConnect(
  pending: PendingSignIn | null,
  params: Record<string, unknown>,
  http: HttpAdapter,
): Promise<ConnectOutcome> {
  if (!pending) return { kind: "stopped", reason: "no_pending" };
  const cb = callbackFromParams(params);
  if (cb.error === "invalid_iss") return { kind: "stopped", reason: "invalid_iss" };
  if (cb.error === "invalid_scope") return { kind: "stopped", reason: "invalid_scope" };
  if (cb.error || !cb.code || !cb.iss) return { kind: "stopped", reason: "cancelled", detail: cb.error };
  try {
    const tokens = await exchangeCode({
      baseUrl: cb.iss,
      code: cb.code,
      state: cb.state,
      expectedState: pending.state,
      codeVerifier: pending.verifier,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      http,
    });
    return { kind: "connected", iss: cb.iss, tokens };
  } catch (e) {
    if (e instanceof PlumOAuthError && (e.code === "invalid_iss" || e.code === "invalid_state")) {
      return { kind: "stopped", reason: e.code };
    }
    return { kind: "stopped", reason: "failed", detail: (e as Error).message };
  }
}

/**
 * Drop a legacy data.json token whose box address is not a Plum box's own
 * address. Version 0.1 stored whatever `iss` came back, unchecked; a token is
 * never sent to anything else. Returns true when it changed the settings.
 */
export function forgetUncheckedBox(settings: PlumSyncSettings): boolean {
  if (!settings.baseUrl && !settings.token) return false;
  if (isPlumIssuer(settings.baseUrl)) return false;
  settings.baseUrl = "";
  settings.token = "";
  settings.account = "";
  return true;
}
