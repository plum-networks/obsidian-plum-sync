// This device's connection: where it is kept, which one is used, the folder it
// syncs to, and the client that refreshes it — against the vendored SDK.
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PlumAuthError, PlumForbiddenError, type HttpAdapter, type HttpRequest, type HttpResponse } from "@plumbox/client";
import {
  activeConnection,
  CONNECTION_KEY,
  ConnectionStore,
  connectionFromTokens,
  mayReadProfile,
  openClient,
  remoteRootFor,
  saveRotatedTokens,
  type ActiveConnection,
  type DeviceStorage,
} from "../src/connection.js";
import { useBaseFor } from "../src/sync/base.js";
import { DEFAULT_SETTINGS, type Connection, type PlumSyncSettings } from "../src/types.js";

if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

const BOX = "https://pb-0123456789abcdef0123456789ab7f3a.plumbox.me";
const APP = "/Apps/Obsidian Sync";
/** Fixed, so two conn() calls compare equal. */
const EXPIRES = Date.now() + 3600_000;

function settings(over: Partial<PlumSyncSettings> = {}): PlumSyncSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...over };
}

/** Obsidian 1.8.7+: per-vault local storage, values kept as JSON like Obsidian does. */
function deviceApp(): DeviceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    loadLocalStorage(key: string) {
      const v = data.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    saveLocalStorage(key: string, value: unknown) {
      if (value === null) data.delete(key);
      else data.set(key, JSON.stringify(value));
    },
  };
}

function conn(over: Partial<Connection> = {}): Connection {
  return {
    id: "c1",
    iss: BOX,
    accessToken: "plum_pat_1",
    refreshToken: "plum_rt_1",
    expiresAt: EXPIRES,
    appFolder: APP,
    scope: "files:app user:profile",
    account: "ann@example.com",
    ...over,
  };
}

describe("ConnectionStore", () => {
  it("keeps the connection on this device, never in data.json, where Obsidian can", async () => {
    const app = deviceApp();
    const s = settings();
    const saveSettings = vi.fn(async () => {});
    const store = new ConnectionStore(app, () => s, saveSettings);
    expect(store.deviceLocal).toBe(true);
    await store.save(conn());
    expect(app.data.has(CONNECTION_KEY)).toBe(true);
    expect(s.connection).toBeNull();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(store.load()).toEqual(conn());
    await store.save(null);
    expect(store.load()).toBeNull();
  });

  it("never takes a refresh token from data.json where it has local storage", () => {
    // Another device on old Obsidian may have left its connection there.
    const s = settings({ connection: conn() });
    expect(new ConnectionStore(deviceApp(), () => s, async () => {}).load()).toBeNull();
  });

  it("falls back to data.json on Obsidian without local storage", async () => {
    const s = settings();
    const saveSettings = vi.fn(async () => {});
    const store = new ConnectionStore({}, () => s, saveSettings);
    expect(store.deviceLocal).toBe(false);
    await store.save(conn());
    expect(s.connection).toEqual(conn());
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(store.load()).toEqual(conn());
  });

  it("ignores a stored connection for anything but a Plum box", () => {
    const app = deviceApp();
    const store = new ConnectionStore(app, () => settings(), async () => {});
    for (const iss of ["https://pb-x-lan.plumbox.me", "https://evil.example", BOX + "/"]) {
      app.saveLocalStorage!(CONNECTION_KEY, conn({ iss }));
      expect(store.load()).toBeNull();
    }
  });
});

describe("activeConnection", () => {
  it("uses this device's own connection first", () => {
    const app = deviceApp();
    const s = settings({ baseUrl: BOX, token: "plum_pat_legacy" });
    const store = new ConnectionStore(app, () => s, async () => {});
    app.saveLocalStorage!(CONNECTION_KEY, conn());
    expect(activeConnection(store, s)).toMatchObject({ kind: "own", accessToken: "plum_pat_1", appFolder: APP });
  });

  it("keeps a 0.2 token from data.json working as it is: never refreshed, no app folder", () => {
    const s = settings({ baseUrl: BOX, token: "plum_pat_legacy", account: "ann@example.com" });
    const store = new ConnectionStore(deviceApp(), () => s, async () => {});
    const c = activeConnection(store, s)!;
    expect(c).toMatchObject({ kind: "legacy", iss: BOX, accessToken: "plum_pat_legacy", account: "ann@example.com" });
    expect(c.refreshToken).toBeUndefined();
    expect(c.appFolder).toBeUndefined();
  });

  it("is null when nothing is connected, or the legacy box is not a Plum box", () => {
    const store = new ConnectionStore(deviceApp(), () => settings(), async () => {});
    expect(activeConnection(store, settings())).toBeNull();
    expect(activeConnection(store, settings({ baseUrl: "https://evil.example", token: "t" }))).toBeNull();
  });
});

describe("a new connection", () => {
  it("keeps every token the box returned, under a fresh id", () => {
    const tokens = {
      accessToken: "plum_pat_1",
      tokenType: "bearer",
      scope: "files:app user:profile",
      refreshToken: "plum_rt_1",
      expiresAt: 123,
      appFolder: APP,
    };
    const a = connectionFromTokens(BOX, tokens);
    const b = connectionFromTokens(BOX, tokens);
    expect(a).toMatchObject({ iss: BOX, accessToken: "plum_pat_1", refreshToken: "plum_rt_1", expiresAt: 123, appFolder: APP, account: "" });
    expect(a.id).toMatch(/^[0-9a-f]{24}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("asks who the account is only when user:profile was granted", () => {
    expect(mayReadProfile(conn({ scope: "files:app user:profile" }))).toBe(true);
    expect(mayReadProfile(conn({ scope: "files:app" }))).toBe(false);
    expect(mayReadProfile(conn({ scope: "" }))).toBe(true); // a token that does not say: as before
    expect(mayReadProfile(conn({ scope: "files:read files:write" }))).toBe(false);
  });
});

describe("remoteRootFor", () => {
  it("syncs an app-folder connection to <appFolder>/<vault>, whatever the setting says", () => {
    const s = settings({ remoteRoot: "/Obsidian/Notes" });
    expect(remoteRootFor(conn(), s, "Notes")).toBe("/Apps/Obsidian Sync/Notes");
    expect(remoteRootFor(conn({ appFolder: "/Apps/Obsidian Sync/" }), s, "Notes")).toBe("/Apps/Obsidian Sync/Notes");
    expect(remoteRootFor(conn({ appFolder: "/Apps/Obsidian Sync" }), settings({ remoteRoot: "/Photos" }), "V")).toBe(
      "/Apps/Obsidian Sync/V",
    );
  });

  it("keeps the setting (default /Obsidian/<vault>) for a connection without one", () => {
    const legacy = conn({ appFolder: undefined });
    expect(remoteRootFor(legacy, settings({ remoteRoot: "/Notes" }), "V")).toBe("/Notes");
    expect(remoteRootFor(legacy, settings(), "V")).toBe("/Obsidian/V");
  });
});

describe("useBaseFor", () => {
  const snap = { hash: "h", mtime: 1 };

  it("starts from an empty base when the folder changes, so nothing reads as deleted", () => {
    const s = settings({ base: { "a.md": snap }, baseRoot: "/Obsidian/V" });
    expect(useBaseFor(s, "/Apps/Obsidian Sync/V", "/Obsidian/V")).toBe(true);
    expect(s.base).toEqual({});
    expect(s.baseRoot).toBe("/Apps/Obsidian Sync/V");
  });

  it("treats a 0.2 base as belonging to the folder 0.2 synced to", () => {
    const moved = settings({ base: { "a.md": snap }, remoteRoot: "/Obsidian/V" });
    expect(useBaseFor(moved, "/Apps/Obsidian Sync/V", "/Obsidian/V")).toBe(true);
    expect(moved.base).toEqual({});

    const same = settings({ base: { "a.md": snap }, remoteRoot: "/Obsidian/V" });
    expect(useBaseFor(same, "/Obsidian/V", "/Obsidian/V")).toBe(false);
    expect(same.base).toEqual({ "a.md": snap });
    expect(same.baseRoot).toBe("/Obsidian/V");
  });

  it("keeps the base for the same folder, trailing slashes aside", () => {
    const s = settings({ base: { "a.md": snap }, baseRoot: "/Apps/Obsidian Sync/V/" });
    expect(useBaseFor(s, "/Apps/Obsidian Sync/V", "/Obsidian/V")).toBe(false);
    expect(s.base).toEqual({ "a.md": snap });
  });
});

describe("saveRotatedTokens", () => {
  const rotated = { accessToken: "plum_pat_2", tokenType: "bearer", scope: "files:app user:profile", refreshToken: "plum_rt_2", expiresAt: 999 };

  it("writes the new tokens into the connection and keeps the rest", async () => {
    const app = deviceApp();
    const store = new ConnectionStore(app, () => settings(), async () => {});
    await store.save(conn());
    await saveRotatedTokens(store, "c1", rotated);
    expect(store.load()).toEqual(conn({ accessToken: "plum_pat_2", refreshToken: "plum_rt_2", expiresAt: 999 }));
  });

  it("does not bring back a connection that was disconnected or replaced meanwhile", async () => {
    const app = deviceApp();
    const store = new ConnectionStore(app, () => settings(), async () => {});
    await saveRotatedTokens(store, "c1", rotated);
    expect(store.load()).toBeNull();
    await store.save(conn({ id: "c2", accessToken: "plum_pat_new" }));
    await saveRotatedTokens(store, "c1", rotated);
    expect(store.load()!.accessToken).toBe("plum_pat_new");
  });
});

describe("openClient", () => {
  function json(status: number, body: unknown): HttpResponse {
    return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer };
  }

  /** A box that rotates tokens on refresh and keeps a files:app token in its folder. */
  function fakeBox() {
    const state = { access: "plum_pat_1", refresh: "plum_rt_1", n: 1, refreshes: 0, refuse: false };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const seen: HttpRequest[] = [];
    const http: HttpAdapter = {
      async request(req) {
        seen.push(req);
        const url = new URL(req.url);
        if (url.pathname === "/api/oauth/token") {
          state.refreshes++;
          await gate;
          const body = JSON.parse(req.body as string) as Record<string, string>;
          if (state.refuse || body.refresh_token !== state.refresh || body.client_id !== "im.plum.obsidian-sync:obsidian") {
            return json(400, { error: "invalid_grant" });
          }
          state.n++;
          state.access = `plum_pat_${state.n}`;
          state.refresh = `plum_rt_${state.n}`;
          return json(200, {
            access_token: state.access,
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: state.refresh,
            scope: "files:app user:profile",
            app_folder: APP,
          });
        }
        if (req.headers?.["authorization"] !== `Bearer ${state.access}`) return json(401, { error: "invalid_token" });
        const path = url.searchParams.get("path") ?? "";
        if (!path.startsWith(APP)) return json(403, { error: "forbidden" });
        return json(200, { items: [], total: 0, limit: 1000, offset: 0 });
      },
    };
    return { state, seen, http, release };
  }

  function setup(c: ActiveConnection) {
    const box = fakeBox();
    const app = deviceApp();
    const store = new ConnectionStore(app, () => settings(), async () => {});
    const ended = vi.fn();
    const client = openClient(c, {
      http: box.http,
      saveTokens: (id, t) => saveRotatedTokens(store, id, t),
      ended,
    });
    return { box, store, ended, client };
  }

  it("four sync actions on an expired token share one refresh, and the rotated set is saved", async () => {
    const own: ActiveConnection = { ...conn(), kind: "own" };
    const { box, store, ended, client } = setup(own);
    await store.save(conn());
    box.state.access = "plum_pat_expired"; // the box has moved on from plum_pat_1
    box.state.refresh = "plum_rt_1";
    const work = Promise.all([1, 2, 3, 4].map((i) => client.drive.list(`${APP}/V/${i}`)));
    await vi.waitFor(() => expect(box.state.refreshes).toBe(1));
    box.release();
    await work;
    expect(box.state.refreshes).toBe(1);
    expect(ended).not.toHaveBeenCalled();
    expect(store.load()).toMatchObject({ accessToken: "plum_pat_2", refreshToken: "plum_rt_2", account: "ann@example.com", appFolder: APP });
  });

  it("ends the connection once when the box refuses the refresh", async () => {
    const own: ActiveConnection = { ...conn(), kind: "own" };
    const { box, ended, client } = setup(own);
    box.state.access = "plum_pat_expired";
    box.state.refuse = true;
    box.release();
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) => client.drive.list(`${APP}/V/${i}`)));
    expect(results.every((r) => r.status === "rejected" && r.reason instanceof PlumAuthError)).toBe(true);
    expect(ended).toHaveBeenCalledOnce();
    expect(ended.mock.calls[0]![0]).toBe(own);
  });

  it("a 403 (outside the app folder) does not end anything", async () => {
    const own: ActiveConnection = { ...conn(), kind: "own" };
    const { box, ended, client } = setup(own);
    await expect(client.drive.list("/Photos")).rejects.toBeInstanceOf(PlumForbiddenError);
    expect(box.state.refreshes).toBe(0);
    expect(ended).not.toHaveBeenCalled();
  });

  it("never refreshes a 0.2 token; a rejected one ends the connection", async () => {
    const legacy: ActiveConnection = { kind: "legacy", id: "legacy:x", iss: BOX, accessToken: "plum_pat_legacy", scope: "", account: "" };
    const { box, ended, client } = setup(legacy);
    box.state.access = "plum_pat_legacy";
    await client.drive.list(`${APP}/V`);
    box.state.access = "plum_pat_someone_else";
    await expect(client.drive.list(`${APP}/V`)).rejects.toBeInstanceOf(PlumAuthError);
    expect(box.state.refreshes).toBe(0);
    expect(ended).toHaveBeenCalledOnce();
  });
});
