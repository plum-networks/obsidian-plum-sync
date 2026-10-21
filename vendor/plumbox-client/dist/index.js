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
var PlumForbiddenError = class extends PlumApiError {
  constructor(status, message, code) {
    super(status, message, code);
    this.name = "PlumForbiddenError";
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
  if (status === 401) return new PlumAuthError(status, message, code);
  if (status === 403) return new PlumForbiddenError(status, message, code);
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
    /** The box trash. Not open to a `files:app` token (403). */
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
  /**
   * mkdir -p: create every missing segment of `path`.
   *
   * A parent the token may not touch is passed over: a `files:app` token gets
   * 403 on `/Apps` itself, yet may create folders inside its app folder (which
   * the box made when it issued the token). A 403 on the last segment, or on a
   * parent that really is missing, still surfaces.
   */
  async ensureDir(path) {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < segments.length; i++) {
      current += "/" + segments[i];
      try {
        await this.mkdir(current);
      } catch (err) {
        const status = err.status;
        if (status === 409 || status === 500) continue;
        if (status === 403 && i < segments.length - 1) continue;
        throw err;
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
   * read scope); a token with only `files:app` gets 403
   * (`PlumForbiddenError`). What a SKU unlocks is up to your app; the box
   * only proves the receipt.
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

// src/env.ts
var PRODUCTION = Object.freeze({
  name: "production",
  boxDomain: "plumbox.me",
  portalOrigin: "https://plumbox.me",
  relayUrl: "https://relay.plumbox.me"
});
var STAGING = Object.freeze({
  name: "staging",
  boxDomain: "staging.plumbox.me",
  portalOrigin: "https://staging.plumbox.me",
  relayUrl: "https://relay.staging.plumbox.me"
});
var ENVIRONMENTS = [PRODUCTION, STAGING];
function plumEnvironment(boxDomain) {
  if (boxDomain === void 0 || boxDomain === "") return PRODUCTION;
  const want = boxDomain.toLowerCase();
  const found = ENVIRONMENTS.find((e) => e.boxDomain === want);
  if (!found) throw new Error(`unknown Plum box domain "${boxDomain}" (only plumbox.me and staging.plumbox.me exist)`);
  return found;
}
function environmentOfHost(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  let best;
  for (const e of ENVIRONMENTS) {
    if ((h === e.boxDomain || h.endsWith("." + e.boxDomain)) && (!best || e.boxDomain.length > best.boxDomain.length)) {
      best = e;
    }
  }
  return best;
}
function isForeignUrl(url, env) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const owner = environmentOfHost(host);
  return owner !== void 0 && owner.name !== env.name;
}

// src/oauth.ts
var DEFAULT_PORTAL_URL = PRODUCTION.portalOrigin;
function issuerPattern(boxDomain) {
  const domain = boxDomain.replace(/\./g, "\\.");
  return new RegExp(`^https:\\/\\/pb-[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?\\.${domain}$`);
}
var PLUM_ISSUER_PATTERN = issuerPattern(PRODUCTION.boxDomain);
function isPlumIssuer(iss, boxDomain) {
  const domain = plumEnvironment(boxDomain).boxDomain;
  return typeof iss === "string" && (domain === PRODUCTION.boxDomain ? PLUM_ISSUER_PATTERN : issuerPattern(domain)).test(iss) && !iss.endsWith(`-lan.${domain}`) && !iss.endsWith(`-wan.${domain}`);
}
function parseCallback(callbackUrl, opts) {
  const u = new URL(callbackUrl);
  return checkCallback((k) => u.searchParams.getAll(k), opts?.boxDomain);
}
function callbackFromParams(params, opts) {
  return checkCallback((k) => {
    const v = params[k];
    if (v === void 0 || v === null) return [];
    return Array.isArray(v) ? v.map(String) : [String(v)];
  }, opts?.boxDomain);
}
function checkCallback(all, boxDomain) {
  plumEnvironment(boxDomain);
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
  if (iss === null || iss !== void 0 && !isPlumIssuer(iss, boxDomain)) {
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
async function nodeWebCrypto() {
  try {
    const nodeCrypto = await import("crypto");
    return nodeCrypto.webcrypto;
  } catch {
    return void 0;
  }
}
async function randomBytes(n) {
  const g = globalThis.crypto;
  const c = g?.getRandomValues ? g : await nodeWebCrypto();
  if (!c?.getRandomValues) throw new Error("no secure RNG available");
  return c.getRandomValues(new Uint8Array(n));
}
async function sha256(bytes) {
  const g = globalThis.crypto;
  const subtle = g?.subtle ?? (await nodeWebCrypto())?.subtle;
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
  const portal = (opts.portalUrl ?? plumEnvironment(opts.boxDomain).portalOrigin).replace(/\/+$/, "");
  const codeVerifier = b64url(await randomBytes(32));
  const codeChallenge = b64url(await sha256(new TextEncoder().encode(codeVerifier)));
  const state = b64url(await randomBytes(16));
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
  const domain = plumEnvironment(opts.boxDomain).boxDomain;
  if (!isPlumIssuer(iss, domain)) {
    throw new PlumOAuthError(
      "invalid_iss",
      `exchangeCode: the callback's iss is not a Plum box (https://pb-\u2026.${domain}); nothing was sent`
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
  return tokensFromResponse(res, Date.now());
}
async function refreshTokens(opts) {
  const iss = opts.iss;
  const domain = plumEnvironment(opts.boxDomain).boxDomain;
  if (!isPlumIssuer(iss, domain)) {
    throw new PlumOAuthError(
      "invalid_iss",
      `refreshTokens: iss is not a Plum box (https://pb-\u2026.${domain}); nothing was sent`
    );
  }
  if (!opts.refreshToken || !opts.clientId) {
    throw new PlumOAuthError("invalid_request", "refreshTokens: refreshToken and clientId are required");
  }
  const http = opts.http ?? fetchAdapter;
  const res = await http.request({
    url: iss + "/api/oauth/token",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId
    })
  });
  if (res.status !== 200) {
    const err = errorFromResponse(res.status, responseText(res));
    if (err.code === "invalid_grant") throw new PlumAuthError(err.status, err.message, "invalid_grant");
    throw err;
  }
  const tokens = tokensFromResponse(res, Date.now());
  if (!tokens.refreshToken) tokens.refreshToken = opts.refreshToken;
  return tokens;
}
function tokensFromResponse(res, now) {
  let body;
  try {
    body = JSON.parse(responseText(res));
  } catch {
    body = {};
  }
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new PlumApiError(res.status, "the token response carried no access_token", "invalid_token_response");
  }
  const out = {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === "string" && body.token_type ? body.token_type : "bearer",
    scope: typeof body.scope === "string" ? body.scope : ""
  };
  if (typeof body.refresh_token === "string" && body.refresh_token) out.refreshToken = body.refresh_token;
  if (typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0) {
    out.expiresAt = now + body.expires_in * 1e3;
  }
  if (typeof body.app_folder === "string" && body.app_folder.startsWith("/")) out.appFolder = body.app_folder;
  return out;
}

// src/client.ts
var TOKEN_STORAGE_KEY = "plumbox.token";
var REFRESH_MARGIN_MS = 6e4;
function isReplayable(body) {
  if (body === void 0 || typeof body === "string") return true;
  if (ArrayBuffer.isView(body)) return true;
  return Object.prototype.toString.call(body) === "[object ArrayBuffer]";
}
function parseStoredTokens(stored) {
  const s = stored.trim();
  if (!s) return null;
  if (!s.startsWith("{")) return { accessToken: s, tokenType: "bearer", scope: "" };
  try {
    const t = JSON.parse(s);
    if (typeof t.accessToken !== "string" || !t.accessToken) return null;
    const out = {
      accessToken: t.accessToken,
      tokenType: typeof t.tokenType === "string" && t.tokenType ? t.tokenType : "bearer",
      scope: typeof t.scope === "string" ? t.scope : ""
    };
    if (typeof t.refreshToken === "string" && t.refreshToken) out.refreshToken = t.refreshToken;
    if (typeof t.expiresAt === "number" && Number.isFinite(t.expiresAt)) out.expiresAt = t.expiresAt;
    if (typeof t.appFolder === "string" && t.appFolder) out.appFolder = t.appFolder;
    return out;
  } catch {
    return null;
  }
}
var PlumClient = class {
  constructor(opts) {
    this.scope = "";
    this.sessionCookie = null;
    /** The refresh every waiting request shares (single flight). */
    this.refreshing = null;
    /** Bumped whenever the tokens are replaced from outside, so a late refresh result is dropped. */
    this.generation = 0;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const env = plumEnvironment(opts.boxDomain);
    if (isForeignUrl(this.baseUrl, env)) {
      throw new Error(`PlumClient: ${this.baseUrl} is not a box of ${env.boxDomain}`);
    }
    this.portalOrigin = (opts.portalOrigin ?? env.portalOrigin).replace(/\/+$/, "");
    if (isForeignUrl(this.portalOrigin, env)) {
      throw new Error(`PlumClient: ${this.portalOrigin} is not the portal of ${env.boxDomain}`);
    }
    this.boxDomain = env.boxDomain;
    this.http = opts.http ?? fetchAdapter;
    this.clientId = opts.clientId?.trim() || void 0;
    this.iss = opts.iss ?? this.baseUrl;
    this.tokenStorage = opts.tokenStorage;
    this.onAuthError = opts.onAuthError;
    this.onTokens = opts.onTokens;
    if (opts.token || opts.refreshToken) {
      this.adopt({
        accessToken: opts.token ?? "",
        tokenType: "bearer",
        scope: "",
        refreshToken: opts.refreshToken,
        // A refresh token without an access token: refresh before the first request.
        expiresAt: opts.token ? opts.expiresAt : 0,
        appFolder: opts.appFolder
      });
    }
    this.drive = new DriveApi(this);
    this.auth = new AuthApi(this);
    this.apps = new AppsApi(this);
  }
  /**
   * Load previously stored tokens from tokenStorage (a token set saved by
   * 0.4.0+, or a bare token saved by an older version). Returns true when found.
   */
  async loadToken() {
    if (!this.tokenStorage) return false;
    const stored = await this.tokenStorage.get(TOKEN_STORAGE_KEY);
    const tokens = stored ? parseStoredTokens(stored) : null;
    if (!tokens) return false;
    this.adopt(tokens);
    return true;
  }
  /**
   * Adopt a token for all subsequent requests (and persist it when storage is
   * configured): a PAT string, or the whole `OAuthTokens` from `exchangeCode`
   * — pass the whole set so the client can refresh it.
   */
  async setToken(token) {
    const tokens = typeof token === "string" ? { accessToken: token, tokenType: "bearer", scope: "" } : token;
    this.adopt(tokens);
    await this.tokenStorage?.set(TOKEN_STORAGE_KEY, typeof token === "string" ? token : JSON.stringify(this.currentTokens()));
  }
  async clearToken() {
    this.generation++;
    this.token = this.refreshToken = this.expiresAt = this.folder = void 0;
    this.scope = "";
    await this.tokenStorage?.delete(TOKEN_STORAGE_KEY);
  }
  get hasToken() {
    return !!this.token;
  }
  get hasSession() {
    return !!this.sessionCookie;
  }
  /** The folder a `files:app` token may use (`OAuthTokens.appFolder`), when known. */
  get appFolder() {
    return this.folder;
  }
  /**
   * Refresh the access token now. Concurrent callers (and requests that hit
   * a 401 meanwhile) share one refresh. Rejects with `PlumAuthError` code
   * `invalid_grant` when the connection is gone (and fires `onAuthError`), or
   * with a transport/`PlumApiError` when the box could not be reached (the
   * refresh token is still good).
   */
  refresh() {
    if (!this.refreshToken) {
      return Promise.reject(new Error("PlumClient.refresh: this client holds no refresh token"));
    }
    return this.refreshShared();
  }
  adopt(t) {
    if (t.refreshToken) {
      if (!this.clientId) {
        throw new Error("PlumClient: a refresh token needs the clientId option (the client id the tokens were issued to)");
      }
      if (!isPlumIssuer(this.iss, this.boxDomain)) {
        throw new Error(
          `PlumClient: refreshing needs the box's verified iss (https://pb-\u2026.${this.boxDomain}); pass it as the iss option`
        );
      }
    }
    this.generation++;
    this.token = t.accessToken;
    this.refreshToken = t.refreshToken || void 0;
    this.expiresAt = t.expiresAt;
    this.scope = t.scope ?? "";
    this.folder = t.appFolder || void 0;
  }
  currentTokens() {
    const out = { accessToken: this.token ?? "", tokenType: "bearer", scope: this.scope };
    if (this.refreshToken) out.refreshToken = this.refreshToken;
    if (this.expiresAt !== void 0) out.expiresAt = this.expiresAt;
    if (this.folder) out.appFolder = this.folder;
    return out;
  }
  refreshShared() {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }
  async doRefresh() {
    const sent = this.refreshToken;
    const generation = this.generation;
    if (!sent || !this.clientId) throw new Error("PlumClient: no refresh token");
    let next;
    try {
      next = await refreshTokens({
        iss: this.iss,
        clientId: this.clientId,
        refreshToken: sent,
        http: this.http,
        boxDomain: this.boxDomain
      });
    } catch (err) {
      if (err instanceof PlumAuthError && err.code === "invalid_grant" && generation === this.generation) {
        this.refreshToken = void 0;
        this.fireAuthError(err, this.token);
      }
      throw err;
    }
    if (generation !== this.generation && this.refreshToken !== sent) return;
    this.token = next.accessToken;
    this.refreshToken = next.refreshToken;
    this.expiresAt = next.expiresAt;
    if (next.scope) this.scope = next.scope;
    if (next.appFolder) this.folder = next.appFolder;
    const tokens = this.currentTokens();
    try {
      await this.tokenStorage?.set(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
    } catch {
    }
    try {
      await this.onTokens?.(tokens);
    } catch {
    }
  }
  refreshDue() {
    return !!this.refreshToken && this.expiresAt !== void 0 && Date.now() >= this.expiresAt - REFRESH_MARGIN_MS;
  }
  fireAuthError(err, sentWith) {
    if (sentWith !== void 0 && sentWith === this.authErrorToken) return;
    this.authErrorToken = sentWith;
    this.onAuthError?.(err);
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
  /**
   * Internal: perform an API request with auth + error mapping.
   *
   * With a refresh token, an access token about to expire is refreshed first,
   * and a 401 is answered by one refresh (shared with every request waiting on
   * it) and one more try of the same request. A 401 is the box refusing the
   * credential before it reads the request, so the second try is not a
   * duplicate write; the body is sent again byte for byte. A body that cannot
   * be sent twice is not retried: the request fails with `PlumApiError` code
   * `token_refreshed` (status 401) once the token is fresh — send it again.
   */
  async request(path, opts = {}) {
    if (this.refreshDue() || this.refreshing) {
      try {
        await this.refreshShared();
      } catch (err) {
        if (err instanceof PlumAuthError || this.expiresAt === void 0 || Date.now() >= this.expiresAt) throw err;
      }
    }
    let sentWith = this.token;
    let res = await this.send(path, opts);
    if (res.status === 401 && sentWith && this.refreshToken && !opts.allowStatus?.includes(401)) {
      if (this.token === sentWith) await this.refreshShared();
      if (!isReplayable(opts.body)) {
        throw new PlumApiError(
          401,
          "the access token was refreshed, but this request's body cannot be sent twice \u2014 send it again",
          "token_refreshed"
        );
      }
      sentWith = this.token;
      res = await this.send(path, opts);
    }
    const ok = opts.allowStatus ? opts.allowStatus.includes(res.status) : res.status >= 200 && res.status < 300;
    if (!ok) {
      const err = errorFromResponse(res.status, responseText(res));
      if (err instanceof PlumAuthError) this.fireAuthError(err, sentWith);
      throw err;
    }
    return res;
  }
  send(path, opts) {
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
    return this.http.request({
      url: joinURL(this.baseUrl, path),
      method: opts.method ?? "GET",
      headers,
      body
    });
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
var DEFAULT_RELAY_URL = PRODUCTION.relayUrl;
async function discover(email, opts) {
  const env = plumEnvironment(opts?.boxDomain);
  const relay = (opts?.relayUrl ?? env.relayUrl).replace(/\/+$/, "");
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
  return { subdomain, baseUrl: `https://${subdomain}.${env.boxDomain}` };
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
export {
  AppsApi,
  AuthApi,
  DEFAULT_PORTAL_URL,
  DEFAULT_RELAY_URL,
  DriveApi,
  PLUM_ISSUER_PATTERN,
  PRODUCTION,
  PlumApiError,
  PlumAuthError,
  PlumClient,
  PlumForbiddenError,
  PlumOAuthError,
  STAGING,
  beginAuthorization,
  callbackFromParams,
  discover,
  exchangeCode,
  fetchAdapter,
  injectedAdapter,
  isForeignUrl,
  isPlumIssuer,
  parseCallback,
  plumEnvironment,
  refreshTokens
};
