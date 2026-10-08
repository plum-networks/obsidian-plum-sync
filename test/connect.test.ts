// The sign-in steps of the plugin, against the vendored @plumbox/client build
// (the code that ships in main.js). v3 contract 10.1 (iss) and 10.2 / D12
// (client_id).
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as sdk from "@plumbox/client";
import type { HttpAdapter } from "@plumbox/client";
import { beginConnect, finishConnect, forgetUncheckedBox, type PendingSignIn } from "../src/connect.js";
import { CLIENT_ID, DEFAULT_SETTINGS, REDIRECT_URI, SCOPES, type PlumSyncSettings } from "../src/types.js";

// Node 18 has no global crypto; PKCE needs it.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

const BOX = "https://pb-0123456789abcdef0123456789ab7f3a.plumbox.me";
const PENDING: PendingSignIn = { verifier: "v".repeat(43), state: "STATE-1" };

function spy(status = 200, body = `{"access_token":"plum_pat_x","token_type":"bearer","scope":"files:read files:write"}`) {
  const sent: { url: string; body: string }[] = [];
  const http: HttpAdapter = {
    async request(req) {
      sent.push({ url: req.url, body: String(req.body) });
      return { status, headers: {}, body: new TextEncoder().encode(body).buffer as ArrayBuffer };
    },
  };
  return { sent, http };
}

describe("client identity (D12)", () => {
  // core: internal/oauth/registry.go ("<app_id>:<label>"),
  // internal/apps/manifest.go (idRe, clientLabelRe, ReservedAppIDs).
  const appIdRe = /^[a-z0-9][a-z0-9._-]{0,127}$/;
  const labelRe = /^[a-z0-9-]{1,32}$/;

  it("is the registered client im.plum.obsidian-sync:obsidian", () => {
    expect(CLIENT_ID).toBe("im.plum.obsidian-sync:obsidian");
  });

  it("has the shape the box's registry accepts", () => {
    const parts = CLIENT_ID.split(":");
    expect(parts).toHaveLength(2);
    const [appId, label] = parts as [string, string];
    expect(appId).toMatch(appIdRe);
    expect(["files", "runtime"]).not.toContain(appId);
    expect(label).toMatch(labelRe);
  });

  it("asks for files only, never admin, at a native redirect", () => {
    expect([...SCOPES].sort()).toEqual(["files:read", "files:write"]);
    const u = new URL(REDIRECT_URI);
    expect(u.protocol).toBe("obsidian:");
    expect(u.host).toBe("plum-sync"); // the protocol handler main.ts registers
  });

  it("sends that identity to plumbox.me", async () => {
    const { url, pending } = await beginConnect();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://plumbox.me/authorize");
    expect(u.searchParams.get("client_id")).toBe("im.plum.obsidian-sync:obsidian");
    expect(u.searchParams.get("redirect_uri")).toBe("obsidian://plum-sync");
    expect(u.searchParams.get("scope")).toBe("files:read files:write");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(pending.state);
    expect(pending.verifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe("finishConnect", () => {
  it("exchanges the code at the box the link names and keeps that box", async () => {
    const { sent, http } = spy();
    const out = await finishConnect(PENDING, { action: "plum-sync", code: "C1", state: "STATE-1", iss: BOX }, http);
    expect(out).toEqual({ kind: "connected", baseUrl: BOX, token: "plum_pat_x" });
    expect(sent.map((s) => s.url)).toEqual([BOX + "/api/oauth/token"]);
    expect(JSON.parse(sent[0]!.body)).toEqual({
      grant_type: "authorization_code",
      code: "C1",
      code_verifier: PENDING.verifier,
      client_id: "im.plum.obsidian-sync:obsidian",
      redirect_uri: "obsidian://plum-sync",
    });
  });

  // Appendix C, "SDK: iss 정규식 벡터": none of these may receive the code.
  it.each([
    ["no iss", undefined],
    ["an empty iss", ""],
    ["the box's LAN alias", "https://pb-0123456789abcdef0123456789ab7f3a-lan.plumbox.me"],
    ["the box's WAN alias", "https://pb-0123456789abcdef0123456789ab7f3a-wan.plumbox.me"],
    ["another domain", "https://pb-x.evil.example"],
    ["a lookalike domain", "https://pb-x.plumbox.me.evil.example"],
    ["http", "http://pb-x.plumbox.me"],
    ["a port", "https://pb-x.plumbox.me:8443"],
    ["a path", "https://pb-x.plumbox.me/api"],
    ["the portal", "https://plumbox.me"],
  ])("sends nothing for %s", async (_name, iss) => {
    const { sent, http } = spy();
    const params: Record<string, unknown> = { action: "plum-sync", code: "C1", state: "STATE-1" };
    if (iss !== undefined) params.iss = iss;
    const out = await finishConnect(PENDING, params, http);
    expect(out).toEqual({ kind: "stopped", reason: "invalid_iss" });
    expect(sent).toEqual([]);
  });

  it("sends nothing for a sign-in it did not start", async () => {
    const { sent, http } = spy();
    const out = await finishConnect(PENDING, { code: "C1", state: "SOMEONE-ELSES", iss: BOX }, http);
    expect(out).toEqual({ kind: "stopped", reason: "invalid_state" });
    expect(sent).toEqual([]);

    const noState = await finishConnect(PENDING, { code: "C1", iss: BOX }, http);
    expect(noState).toEqual({ kind: "stopped", reason: "invalid_state" });
    expect(sent).toEqual([]);
  });

  it("sends nothing when no sign-in is in progress", async () => {
    const { sent, http } = spy();
    expect(await finishConnect(null, { code: "C1", state: "STATE-1", iss: BOX }, http)).toEqual({
      kind: "stopped",
      reason: "no_pending",
    });
    expect(sent).toEqual([]);
  });

  it("takes a refusal from an older box, which names no iss", async () => {
    const { sent, http } = spy();
    const out = await finishConnect(PENDING, { error: "access_denied", state: "STATE-1" }, http);
    expect(out).toEqual({ kind: "stopped", reason: "cancelled", detail: "access_denied" });
    expect(sent).toEqual([]);
  });

  it("stops a refusal that names a bad iss", async () => {
    const { sent, http } = spy();
    const out = await finishConnect(PENDING, { error: "access_denied", state: "STATE-1", iss: "https://evil.example" }, http);
    expect(out).toEqual({ kind: "stopped", reason: "invalid_iss" });
    expect(sent).toEqual([]);
  });

  it("reports a refused exchange", async () => {
    const { http } = spy(400, `{"error":"invalid_grant","message":"code used"}`);
    const out = await finishConnect(PENDING, { code: "C1", state: "STATE-1", iss: BOX }, http);
    expect(out.kind).toBe("stopped");
    if (out.kind === "stopped") expect(out.reason).toBe("failed");
  });
});

describe("forgetUncheckedBox", () => {
  const settings = (baseUrl: string, token: string): PlumSyncSettings => ({
    ...DEFAULT_SETTINGS,
    baseUrl,
    token,
    account: "ann@example.com",
  });

  it("keeps a connection to a Plum box", () => {
    const s = settings(BOX, "plum_pat_x");
    expect(forgetUncheckedBox(s)).toBe(false);
    expect(s.token).toBe("plum_pat_x");
  });

  it.each([
    ["a LAN alias", "https://pb-x-lan.plumbox.me"],
    ["another host", "https://evil.example"],
    ["a trailing slash", BOX + "/"],
    ["nothing", ""],
  ])("drops a token saved for %s", (_name, baseUrl) => {
    const s = settings(baseUrl, "plum_pat_x");
    expect(forgetUncheckedBox(s)).toBe(true);
    expect(s.baseUrl).toBe("");
    expect(s.token).toBe("");
    expect(s.account).toBe("");
  });

  it("leaves a never-connected plugin alone", () => {
    const s = settings("", "");
    expect(forgetUncheckedBox(s)).toBe(false);
  });
});

describe("vendored @plumbox/client", () => {
  it("is a build that checks iss and state (0.3.0 or later)", () => {
    expect(typeof sdk.isPlumIssuer).toBe("function");
    expect(typeof sdk.callbackFromParams).toBe("function");
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "vendor", "plumbox-client", "package.json"), "utf8")) as {
      version: string;
    };
    const [major, minor] = pkg.version.split(".").map(Number) as [number, number];
    expect(major > 0 || minor >= 3).toBe(true);
  });
});
