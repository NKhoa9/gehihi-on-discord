import crypto from "crypto";
import { isAdminUser, getAdminIds } from "../core/config_schema.js";
import { logger } from "../utils/logger.js";

const SESSION_COOKIE = "gehihi_session";
const OAUTH_STATE_COOKIE = "gehihi_oauth_state";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

let sessionSecret = null;
let ephemeralAdminToken = null;

function getSessionSecret() {
  if (!sessionSecret) {
    sessionSecret = process.env.WEB_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
  }
  return sessionSecret;
}

function getConfiguredPassword() {
  return (process.env.WEB_PASSWORD || process.env.WEB_ADMIN_TOKEN || "").trim();
}

export function isDiscordOAuthEnabled() {
  return Boolean(
    process.env.DISCORD_CLIENT_ID?.trim() &&
    process.env.DISCORD_CLIENT_SECRET?.trim()
  );
}

export function initWebAuth() {
  getSessionSecret();
  const configured = getConfiguredPassword();
  const oauth = isDiscordOAuthEnabled();
  if (!configured && !oauth) {
    ephemeralAdminToken = crypto.randomBytes(18).toString("base64url");
    logger.warn(`[WebUI] No WEB_PASSWORD or Discord OAuth configured. Ephemeral login token for this session: ${ephemeralAdminToken}`);
  } else if (!configured && oauth && getAdminIds().length === 0) {
    logger.warn("[WebUI] Discord OAuth is enabled, but ADMINS is empty in .env — no Discord users will be permitted to log in.");
  }
}

function constantTimeEquals(a, b) {
  const hashA = crypto.createHash("sha256").update(String(a)).digest();
  const hashB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function signPayload(obj) {
  const data = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", getSessionSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = crypto.createHmac("sha256", getSessionSecret()).update(data).digest("base64url");
  if (!constantTimeEquals(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf-8"));
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function buildCookieHeader(name, value, req, maxAgeSeconds) {
  const isSecure = req.headers["x-forwarded-proto"] === "https" || process.env.WEB_COOKIE_SECURE === "true";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function getAuthenticatedUser(req) {
  const cookies = parseCookies(req);
  const session = verifyToken(cookies[SESSION_COOKIE]);
  if (!session) return null;
  return {
    id: session.id,
    username: session.username,
    method: session.method,
  };
}

export function verifyPasswordLogin(passwordInput) {
  const expected = getConfiguredPassword() || ephemeralAdminToken;
  if (!expected || !passwordInput) return false;
  return constantTimeEquals(String(passwordInput).trim(), expected);
}

export function setSessionCookie(res, req, user) {
  const token = signPayload({
    id: user.id,
    username: user.username,
    method: user.method,
    exp: Date.now() + SESSION_TTL_MS,
  });
  res.setHeader("Set-Cookie", buildCookieHeader(SESSION_COOKIE, token, req, Math.floor(SESSION_TTL_MS / 1000)));
}

export function clearSessionCookie(res, req) {
  res.setHeader("Set-Cookie", buildCookieHeader(SESSION_COOKIE, "", req, 0));
}

export function getAuthCapabilities() {
  return {
    password: true,
    discordOAuth: isDiscordOAuthEnabled(),
    usingEphemeralToken: Boolean(!getConfiguredPassword() && ephemeralAdminToken),
  };
}

export function getOAuthRedirectUri(req) {
  if (process.env.WEB_OAUTH_REDIRECT_URI?.trim()) {
    return process.env.WEB_OAUTH_REDIRECT_URI.trim();
  }
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `localhost:${process.env.WEB_PORT || process.env.PORT || 3000}`;
  return `${proto}://${host}/api/auth/discord/callback`;
}

export function beginDiscordOAuth(req, res) {
  if (!isDiscordOAuthEnabled()) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Discord OAuth is not configured." }));
    return;
  }
  const state = crypto.randomBytes(16).toString("hex");
  const signedState = signPayload({ state, exp: Date.now() + 10 * 60 * 1000 });
  const redirectUri = getOAuthRedirectUri(req);

  const authUrl = new URL("https://discord.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID.trim());
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "identify");
  authUrl.searchParams.set("state", state);

  res.writeHead(302, {
    "Set-Cookie": buildCookieHeader(OAUTH_STATE_COOKIE, signedState, req, 600),
    Location: authUrl.toString(),
  });
  res.end();
}

export async function handleDiscordOAuthCallback(req, res, query) {
  const code = query.get("code");
  const state = query.get("state");
  const cookies = parseCookies(req);
  const stored = verifyToken(cookies[OAUTH_STATE_COOKIE]);

  if (!code || !state || !stored || !constantTimeEquals(state, stored.state)) {
    res.writeHead(302, { Location: "/?auth_error=invalid_state" });
    res.end();
    return;
  }

  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID.trim(),
        client_secret: process.env.DISCORD_CLIENT_SECRET.trim(),
        grant_type: "authorization_code",
        code,
        redirect_uri: getOAuthRedirectUri(req),
      }),
    });

    if (!tokenRes.ok) {
      res.writeHead(302, { Location: "/?auth_error=token_exchange_failed" });
      res.end();
      return;
    }

    const tokenData = await tokenRes.json();
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
      res.writeHead(302, { Location: "/?auth_error=user_fetch_failed" });
      res.end();
      return;
    }

    const discordUser = await userRes.json();
    if (!isAdminUser(discordUser.id)) {
      res.writeHead(302, { Location: "/?auth_error=not_admin" });
      res.end();
      return;
    }

    const sessionToken = signPayload({
      id: discordUser.id,
      username: discordUser.username,
      method: "discord",
      exp: Date.now() + SESSION_TTL_MS,
    });

    res.writeHead(302, {
      "Set-Cookie": [
        buildCookieHeader(SESSION_COOKIE, sessionToken, req, Math.floor(SESSION_TTL_MS / 1000)),
        buildCookieHeader(OAUTH_STATE_COOKIE, "", req, 0),
      ],
      Location: "/",
    });
    res.end();
  } catch (err) {
    logger.error("[WebUI] Discord OAuth callback failed:", err.message);
    res.writeHead(302, { Location: "/?auth_error=oauth_exception" });
    res.end();
  }
}
