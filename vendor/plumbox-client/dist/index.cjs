"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  AppsApi: () => AppsApi,
  AuthApi: () => AuthApi,
  DEFAULT_PORTAL_URL: () => DEFAULT_PORTAL_URL,
  DEFAULT_RELAY_URL: () => DEFAULT_RELAY_URL,
  DriveApi: () => DriveApi,
  PLUM_ISSUER_PATTERN: () => PLUM_ISSUER_PATTERN,
  PlumApiError: () => PlumApiError,
  PlumAuthError: () => PlumAuthError,
  PlumClient: () => PlumClient,
  PlumOAuthError: () => PlumOAuthError,
  beginAuthorization: () => beginAuthorization,
  callbackFromParams: () => callbackFromParams,
  discover: () => discover,
  exchangeCode: () => exchangeCode,
  fetchAdapter: () => fetchAdapter,
  injectedAdapter: () => injectedAdapter,
  isPlumIssuer: () => isPlumIssuer,
  parseCallback: () => parseCallback
});
module.exports = __toCommonJS(index_exports);

// src/adapters/fetch.ts
var fetchAdapter = {
  async request(req) {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "follow"
    });
    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const getSetCookie = res.headers.getSetCookie;
    if (!headers["set-cookie"] && typeof getSetCookie === "function") {
      const cookies = getSetCookie.call(res.headers);
      if (cookies.length > 0) headers["set-cookie"] = cookies.join(", ");
    }
    return { status: res.status, headers, body: await res.arrayBuffer() };
  }
};

// src/errors.ts
var PlumApiError = class extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "PlumApiError";
    this.status = status;
    this.code = code;
  }
};
var PlumAuthError = class extends PlumApiError {
  constructor(status, message, code) {
    super(status, message, code);
    this.name = "PlumAuthError";
  }
};
var PlumOAuthError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlumOAuthError";
    this.code = code;
  }
};
function errorFromResponse(status, bodyText) {
  let message = bodyText.trim();
  let code;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && (parsed.message || parsed.error)) {
      message = parsed.message ?? parsed.error ?? message;
      code = parsed.error;
    }
  } catch {
  }
  if (message.length > 500) message = message.slice(0, 500);
  if (status === 401 || status === 403) return new PlumAuthError(status, message, code);
  return new PlumApiError(status, message, code);
}

// src/http.ts
function responseText(res) {
  return new TextDecoder().decode(res.body);
}
function responseJSON(res) {
  return JSON.parse(responseText(res));
}
function parseSessionCookie(setCookie) {
  if (!setCookie) return null;
  const m = /(?:^|[,;\s])session=([^;,\s]+)/.exec(setCookie);
  return m ? `session=${m[1]}` : null;
}
function joinURL(base, path) {
  return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : "/" + path);
}
function toArrayBuffer(data) {
  if (typeof data === "string") {
    const bytes = new TextEncoder().encode(data);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  if (data instanceof Uint8Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return data;
}
function buildMultipart(fields, file) {
  const boundary = "----plumbox" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const enc = new TextEncoder();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      enc.encode(
        `--${boundary}\r
Content-Disposition: form-data; name="${k}"\r
\r
${v}\r
`
      )
    );
  }
  const escapedName = file.name.replace(/"/g, "%22");
  parts.push(
    enc.encode(
      `--${boundary}\r
Content-Disposition: form-data; name="${file.field}"; filename="${escapedName}"\r
Content-Type: ${file.contentType ?? "application/octet-stream"}\r
\r
`
    )
  );
  parts.push(file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data));
  parts.push(enc.encode(`\r
--${boundary}--\r
`));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.byteLength;
  }
  return {
    body: body.buffer,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

// src/drive.ts
var CHUNKED_THRESHOLD = 8 * 1024 * 1024;
var CHUNK_SIZE = 4 * 1024 * 1024;
var PAGE_SIZE = 1e3;
function dirname(path) {
  const norm = "/" + path.replace(/^\/+/, "").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx <= 0 ? "/" : norm.slice(0, idx);
}
function basename(path) {
  const norm = path.replace(/\/+$/, "");
  return norm.slice(norm.lastIndexOf("/") + 1);
}
var DriveApi = class {
  constructor(client) {
    this.client = client;
    this.trash = {
      list: async () => {
        const res = await this.client.request("/api/drive/trash/list");
        return responseJSON(res);
      },
      restore: async (id) => {
        await this.client.request("/api/drive/restore", { method: "POST", json: { id } });
      },
      empty: async () => {
        await this.client.request("/api/drive/trash/empty", { method: "POST" });
      }
    };
    this.versions = {
      list: async (path) => {
        const params = new URLSearchParams({ path });
        const res = await this.client.request(`/api/drive/versions?${params}`);
        return responseJSON(res);
      },
      restore: async (path, versionId) => {
        await this.client.request("/api/drive/restore-version", {
          method: "POST",
          json: { path, versionId }
        });
      }
    };
  }
  /** List one page. Pass limit/offset for pagination; see `listAll` for iteration. */
  async list(path, opts = {}) {
    const params = new URLSearchParams({ path: path || "/" });
    if (opts.recursive) params.set("recursive", "1");
    if (opts.hash) params.set("hash", "1");
    if (opts.q) params.set("q", opts.q);
    if (opts.sort) params.set("sort", opts.sort);
    if (opts.order) params.set("order", opts.order);
    params.set("limit", String(opts.limit ?? PAGE_SIZE));
    params.set("offset", String(opts.offset ?? 0));
    const res = await this.client.request(`/api/drive/list?${params}`);
    return responseJSON(res);
  }
  /** Iterate every entry under `path`, transparently walking pages. */
  async *listAll(path, opts = {}) {
    let offset = 0;
    for (; ; ) {
      const page = await this.list(path, { ...opts, limit: PAGE_SIZE, offset });
      for (const item of page.items) yield item;
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return;
    }
  }
  async download(path) {
    const params = new URLSearchParams({ path });
    const res = await this.client.request(`/api/drive/download?${params}`);
    return res.body;
  }
  /**
   * Upload `data` as the file at `path` (full drive path including filename).
   * Small files go as one multipart POST; larger ones use the resumable
   * chunked protocol automatically. With `overwrite: true` the file is
   * replaced in place (previous content becomes a version snapshot) — without
   * it a name collision creates "name (2).ext".
   */
  async upload(path, data, opts = {}) {
    const buf = toArrayBuffer(data);
    const dir = dirname(path);
    const name = basename(path);
    if (!name) throw new Error("upload path must include a filename");
    if (buf.byteLength > CHUNKED_THRESHOLD && !opts.overwrite) {
      return this.uploadChunked(dir, name, buf, opts);
    }
    const fields = { path: dir };
    if (opts.overwrite) fields.overwrite = "1";
    const { body, contentType } = buildMultipart(fields, {
      field: "file",
      name,
      data: buf,
      contentType: opts.contentType
    });
    const res = await this.client.request("/api/drive/upload", {
      method: "POST",
      body,
      headers: { "content-type": contentType }
    });
    opts.onProgress?.(buf.byteLength, buf.byteLength);
    const out = responseJSON(res);
    return {
      name: out.name,
      path: out.path,
      isDir: false,
      size: buf.byteLength,
      modTime: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  async uploadChunked(dir, name, buf, opts) {
    const initRes = await this.client.request("/api/uploads/init", {
      method: "POST",
      json: {
        target: "drive",
        path: dir,
        filename: name,
        size: buf.byteLength,
        contentType: opts.contentType ?? "application/octet-stream"
      }
    });
    const { uploadId } = responseJSON(initRes);
    const total = buf.byteLength;
    let sent = 0;
    let finalBody = null;
    while (sent < total) {
      const end = Math.min(sent + CHUNK_SIZE, total);
      const res = await this.client.request(`/api/uploads/${encodeURIComponent(uploadId)}`, {
        method: "PATCH",
        body: buf.slice(sent, end),
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${sent}-${end - 1}/${total}`
        }
      });
      sent = end;
      opts.onProgress?.(sent, total);
      if (sent >= total) finalBody = responseJSON(res);
    }
    const placed = finalBody ?? {};
    return {
      name: placed.name ?? name,
      path: placed.path ?? `${dir === "/" ? "" : dir}/${name}`,
      isDir: false,
      size: total,
      modTime: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  /** Create one directory. Parent must exist — see `ensureDir` for mkdir -p. */
  async mkdir(path) {
    await this.client.request("/api/drive/mkdir", {
      method: "POST",
      json: { path: dirname(path), name: basename(path) }
    });
  }
  /** mkdir -p: create every missing segment of `path`. */
  async ensureDir(path) {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const seg of segments) {
      current += "/" + seg;
      try {
        await this.mkdir(current);
      } catch (err) {
        const status = err.status;
        if (status !== 409 && status !== 500) throw err;
      }
    }
  }
  /** Rename within the same directory. For cross-directory moves use `move`. */
  async rename(path, newName) {
    await this.client.request("/api/drive/rename", {
      method: "POST",
      json: { path, name: newName }
    });
  }
  /** Move a file or directory to an arbitrary path (destination parent must exist). */
  async move(path, newPath) {
    await this.client.request("/api/drive/move", {
      method: "POST",
      json: { path, newPath }
    });
  }
  /** Delete (moves to the box trash — recoverable from the Drive UI). */
  async remove(path) {
    const params = new URLSearchParams({ path });
    await this.client.request(`/api/drive/delete?${params}`, { method: "DELETE" });
  }
};

// src/apps.ts
var AppsApi = class {
  constructor(client) {
    this.client = client;
  }
  /**
   * GET /api/apps/{appId}/status — the runtime state of the app's box-side
   * service. Throws a PlumApiError with status 404 when the app is not
   * installed for this user (or has no service).
   */
  async status(appId) {
    const res = await this.client.request(`/api/apps/${encodeURIComponent(appId)}/status`);
    return responseJSON(res);
  }
  /**
   * Check that the app's service is installed on the box; if it is not,
   * return the links that take the user to install it: `installUrl` opens
   * the Plum app on the store page (`plum://store/<appId>`), `webUrl` opens
   * the box's own web UI for a device without the Plum app. Installation is
   * confirmed by the owner there; afterwards the Plum app returns to your
   * registered redirect URI.
   */
  async ensureServiceInstalled(appId) {
    try {
      const status = await this.status(appId);
      return { installed: true, status };
    } catch (err) {
      if (err instanceof PlumApiError && err.status === 404) {
        const id = encodeURIComponent(appId);
        return {
          installed: false,
          installUrl: `plum://store/${id}`,
          webUrl: `${this.client.baseUrl}/#/store/${id}?install=1`
        };
      }
      throw err;
    }
  }
  /**
   * GET /api/apps/{appId}/entitlement — the store receipts this box holds for
   * the app, as the box verified them. Works before the service is
   * installed. Needs a session or a token with `service:call:<appId>` (or a
   * read scope). What a SKU unlocks is up to your app; the box only proves
   * the receipt.
   */
  async entitlement(appId) {
    const res = await this.client.request(`/api/apps/${encodeURIComponent(appId)}/entitlement`);
    return responseJSON(res);
  }
  /**
   * POST /api/apps/entitlements/refresh — ask the box to fetch its receipts
   * from the store now (right after a purchase). Returns how many receipts
   * the box now holds.
   */
  async refreshEntitlements() {
    const res = await this.client.request(`/api/apps/entitlements/refresh`, { method: "POST" });
    return responseJSON(res).receipts;
  }
};

// src/client.ts
var TOKEN_STORAGE_KEY = "plumbox.token";
var PlumClient = class {
  constructor(opts) {
    this.sessionCookie = null;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.http = opts.http ?? fetchAdapter;
    this.token = opts.token;
    this.tokenStorage = opts.tokenStorage;
    this.onAuthError = opts.onAuthError;
    this.drive = new DriveApi(this);
    this.auth = new AuthApi(this);
    this.apps = new AppsApi(this);
  }
  /** Load a previously stored PAT from tokenStorage. Returns true when found. */
  async loadToken() {
    if (!this.tokenStorage) return false;
    const stored = await this.tokenStorage.get(TOKEN_STORAGE_KEY);
    if (stored) this.token = stored;
    return !!stored;
  }
  /** Adopt a PAT for all subsequent requests (and persist it when storage is configured). */
  async setToken(token) {
    this.token = token;
    await this.tokenStorage?.set(TOKEN_STORAGE_KEY, token);
  }
  async clearToken() {
    this.token = void 0;
    await this.tokenStorage?.delete(TOKEN_STORAGE_KEY);
  }
  get hasToken() {
    return !!this.token;
  }
  get hasSession() {
    return !!this.sessionCookie;
  }
  /**
   * First-factor login with the box account's email/username + password.
   * On success the client holds a session cookie (7-day TTL) — immediately
   * mint a PAT with `auth.createToken` and persist only that.
   *
   * @deprecated Connect with delegated OAuth instead (`beginAuthorization` →
   * `parseCallback` → `exchangeCode`), so the password is typed only on the
   * box's own page. A Plum Box v3 box can answer a sign-in from a new device
   * with a mail code (`requireSecondFactor`); this method cannot complete that
   * step and stops with `PlumApiError` code `second_factor_unsupported`.
   */
  async login(cred) {
    const res = await this.request("/api/auth/login", {
      method: "POST",
      json: { login: cred.login, password: cred.password },
      allowStatus: [200]
    });
    const body = responseJSON(res);
    if (body.requireSecondFactor) {
      throw new PlumApiError(
        res.status,
        "this box asks a new device for a mail code, which PlumClient.login cannot answer \u2014 connect with delegated OAuth (beginAuthorization)",
        "second_factor_unsupported"
      );
    }
    if (body.requireTotp && body.tempToken) {
      const tempToken = body.tempToken;
      return {
        ok: false,
        requireTotp: true,
        verifyTotp: async (code) => {
          const vres = await this.request("/api/auth/totp/verify", {
            method: "POST",
            json: { tempToken, code },
            allowStatus: [200]
          });
          this.captureSession(vres);
          return { ok: true };
        }
      };
    }
    this.captureSession(res);
    return { ok: true };
  }
  captureSession(res) {
    const cookie = parseSessionCookie(res.headers["set-cookie"]);
    if (!cookie) {
      throw errorFromResponse(
        502,
        "login succeeded but no session cookie was visible to the SDK (the HTTP adapter must expose the Set-Cookie header)"
      );
    }
    this.sessionCookie = cookie;
  }
  /** Internal: perform an API request with auth + error mapping. */
  async request(path, opts = {}) {
    const headers = { ...opts.headers ?? {} };
    if (this.token) {
      headers["authorization"] = `Bearer ${this.token}`;
    } else if (this.sessionCookie) {
      headers["cookie"] = this.sessionCookie;
    }
    let body = opts.body;
    if (opts.json !== void 0) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const res = await this.http.request({
      url: joinURL(this.baseUrl, path),
      method: opts.method ?? "GET",
      headers,
      body
    });
    const ok = opts.allowStatus ? opts.allowStatus.includes(res.status) : res.status >= 200 && res.status < 300;
    if (!ok) {
      const err = errorFromResponse(res.status, responseText(res));
      if (err instanceof PlumAuthError) this.onAuthError?.(err);
      throw err;
    }
    return res;
  }
};
var AuthApi = class {
  constructor(client) {
    this.client = client;
  }
  /**
   * Mint a Personal Access Token. Requires a live session (call `login`
   * first). Store `result.token` — it is shown exactly once. Prefer scopes
   * `["read","write"]`; never request `admin` from an app.
   */
  async createToken(opts) {
    const res = await this.client.request("/api/auth/tokens", {
      method: "POST",
      json: opts
    });
    return responseJSON(res);
  }
  async listTokens() {
    const res = await this.client.request("/api/auth/tokens");
    return responseJSON(res);
  }
  async revokeToken(id) {
    await this.client.request(`/api/auth/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  }
  /** Who does the current credential belong to? Also a cheap connectivity check. */
  async me() {
    const res = await this.client.request("/api/auth/me");
    const body = responseJSON(res);
    return body.user ?? body;
  }
  /** Discard the box-side session (call after minting a PAT). */
  async logout() {
    await this.client.request("/api/auth/logout", { method: "POST" });
  }
};

// src/discover.ts
var DEFAULT_RELAY_URL = "https://relay.plumbox.me";
async function discover(email, opts) {
  const relay = (opts?.relayUrl ?? DEFAULT_RELAY_URL).replace(/\/+$/, "");
  const http = opts?.http ?? fetchAdapter;
  const res = await http.request({
    url: `${relay}/api/lookup`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email })
  });
  if (res.status !== 200) {
    throw errorFromResponse(res.status, responseText(res));
  }
  const { subdomain } = responseJSON(res);
  if (!subdomain) {
    throw errorFromResponse(502, "relay lookup returned no subdomain");
  }
  return { subdomain, baseUrl: `https://${subdomain}.plumbox.me` };
}

// src/oauth.ts
var DEFAULT_PORTAL_URL = "https://plumbox.me";
var PLUM_ISSUER_PATTERN = /^https:\/\/pb-[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?\.plumbox\.me$/;
function isPlumIssuer(iss) {
  return typeof iss === "string" && PLUM_ISSUER_PATTERN.test(iss) && !iss.endsWith("-lan.plumbox.me") && !iss.endsWith("-wan.plumbox.me");
}
function parseCallback(callbackUrl) {
  const u = new URL(callbackUrl);
  return checkCallback((k) => u.searchParams.getAll(k));
}
function callbackFromParams(params) {
  return checkCallback((k) => {
    const v = params[k];
    if (v === void 0 || v === null) return [];
    return Array.isArray(v) ? v.map(String) : [String(v)];
  });
}
function checkCallback(all) {
  const one = (k) => {
    const v = all(k);
    if (v.length > 1) return null;
    return v.length === 1 && v[0] !== "" ? v[0] : void 0;
  };
  const code = one("code");
  const state = one("state");
  const iss = one("iss");
  const error = one("error");
  const out = {};
  if (typeof state === "string") out.state = state;
  if (iss === null || iss !== void 0 && !isPlumIssuer(iss)) {
    out.error = "invalid_iss";
    return out;
  }
  if (error !== void 0 || code === null) {
    out.error = typeof error === "string" ? error : "invalid_request";
    if (iss) out.iss = iss;
    return out;
  }
  if (code === void 0) {
    out.error = "invalid_request";
    return out;
  }
  if (!iss) {
    out.error = "invalid_iss";
    return out;
  }
  out.code = code;
  out.iss = iss;
  return out;
}
var b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoaShim(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
function btoaShim(s) {
  const g = globalThis;
  if (typeof g.btoa === "function") return g.btoa(s);
  if (g.Buffer) return g.Buffer.from(s, "binary").toString("base64");
  throw new Error("no base64 encoder available");
}
function randomBytes(n) {
  const g = globalThis;
  const out = new Uint8Array(n);
  if (g.crypto?.getRandomValues) return g.crypto.getRandomValues(out);
  throw new Error("no secure RNG available");
}
async function sha256(bytes) {
  const g = globalThis;
  let subtle = g.crypto?.subtle;
  if (!subtle) {
    const nodeCrypto = await import("crypto");
    subtle = nodeCrypto.webcrypto?.subtle;
  }
  if (!subtle) throw new Error("no SubtleCrypto for PKCE");
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}
async function beginAuthorization(opts) {
  const clientId = (opts.clientId ?? "").trim();
  if (!clientId) {
    throw new Error("beginAuthorization: clientId is required (register one in the Plum developer console)");
  }
  if (!opts.scopes || opts.scopes.length === 0) {
    throw new Error("beginAuthorization: at least one scope is required");
  }
  const portal = (opts.portalUrl ?? DEFAULT_PORTAL_URL).replace(/\/+$/, "");
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(await sha256(new TextEncoder().encode(codeVerifier)));
  const state = b64url(randomBytes(16));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state
  });
  if (opts.clientName) params.set("client_name", opts.clientName);
  return { url: `${portal}/authorize?${params}`, codeVerifier, state };
}
async function exchangeCode(opts) {
  const iss = opts.baseUrl;
  if (!isPlumIssuer(iss)) {
    throw new PlumOAuthError(
      "invalid_iss",
      "exchangeCode: the callback's iss is not a Plum box (https://pb-\u2026.plumbox.me); nothing was sent"
    );
  }
  if (typeof opts.expectedState !== "string" || opts.expectedState === "" || opts.state !== opts.expectedState) {
    throw new PlumOAuthError(
      "invalid_state",
      "exchangeCode: the callback's state is not the one this sign-in began with; nothing was sent"
    );
  }
  if (!opts.code || !opts.codeVerifier) {
    throw new PlumOAuthError("invalid_request", "exchangeCode: code and codeVerifier are required");
  }
  const http = opts.http ?? fetchAdapter;
  const res = await http.request({
    url: iss + "/api/oauth/token",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.codeVerifier,
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri
    })
  });
  if (res.status !== 200) {
    throw errorFromResponse(res.status, responseText(res));
  }
  const body = responseJSON(res);
  return { accessToken: body.access_token, scope: body.scope };
}

// src/adapters/inject.ts
function injectedAdapter(requestUrl) {
  return {
    async request(req) {
      const body = req.body instanceof Uint8Array ? req.body.buffer.slice(
        req.body.byteOffset,
        req.body.byteOffset + req.body.byteLength
      ) : req.body;
      const res = await requestUrl({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body,
        throw: false
        // surface non-2xx as structured errors, not exceptions
      });
      const headers = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) {
        headers[k.toLowerCase()] = v;
      }
      return { status: res.status, headers, body: res.arrayBuffer };
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AppsApi,
  AuthApi,
  DEFAULT_PORTAL_URL,
  DEFAULT_RELAY_URL,
  DriveApi,
  PLUM_ISSUER_PATTERN,
  PlumApiError,
  PlumAuthError,
  PlumClient,
  PlumOAuthError,
  beginAuthorization,
  callbackFromParams,
  discover,
  exchangeCode,
  fetchAdapter,
  injectedAdapter,
  isPlumIssuer,
  parseCallback
});
