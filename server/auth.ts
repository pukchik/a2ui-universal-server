import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as oidc from "openid-client";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Config } from "./config.ts";
import type { Store, Session } from "./storage/store.ts";
import { AppError } from "../packages/core/src/errors.ts";
export const token = () => randomBytes(32).toString("base64url");
export const tokenHash = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export type AuthSession = Session;
export interface AuthProvider {
  resolve(
    req: FastifyRequest,
  ): Session | undefined | Promise<Session | undefined>;
  login?(req: FastifyRequest, reply: FastifyReply): unknown | Promise<unknown>;
  logout?(
    req: FastifyRequest,
    reply: FastifyReply,
    session: Session,
  ): unknown | Promise<unknown>;
}
export async function registerAuth(
  app: FastifyInstance,
  store: Store,
  config: Config,
  adapterName: string,
  custom?: AuthProvider,
) {
  if ((config.AUTH_MODE === "custom") !== Boolean(custom))
    throw new Error(
      "AUTH_MODE=custom требует options.auth; для OIDC/demo не передавайте custom provider",
    );
  const secure = new URL(config.PUBLIC_URL).protocol === "https:";
  const cookie = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
  };
  const read = async (req: FastifyRequest): Promise<Session | undefined> => {
    if (custom) {
      const session = await custom.resolve(req);
      if (!session) return undefined;
      if (
        typeof session.userId !== "string" ||
        !session.userId.trim() ||
        typeof session.name !== "string" ||
        !session.name ||
        typeof session.csrf !== "string" ||
        !session.csrf ||
        !(session.expiresAt instanceof Date)
      )
        throw new AppError(500, "invalid_auth_session");
      if (
        !Number.isFinite(session.expiresAt.getTime()) ||
        session.expiresAt.getTime() <= Date.now()
      )
        return undefined;
      return session;
    }
    const value = req.cookies.a2ui_session;
    const session = value ? await store.session(tokenHash(value)) : undefined;
    if (config.AUTH_MODE === "oidc" && session?.userId === "demo-user")
      return undefined;
    return session;
  };
  const requireUser = async (req: FastifyRequest) => {
    const session = await read(req);
    if (!session) throw new AppError(401, "login_required");
    return session;
  };
  const csrf = (req: FastifyRequest, session: Session) => {
    const value = req.headers["x-csrf-token"];
    const origin = req.headers.origin;
    if (
      origin !== new URL(config.PUBLIC_URL).origin ||
      typeof value !== "string" ||
      Buffer.byteLength(value) !== Buffer.byteLength(session.csrf) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(session.csrf))
    )
      throw new AppError(403, "csrf");
  };
  const signIn = async (reply: FastifyReply, userId: string, name: string) => {
    const secret = token();
    const session = {
      userId,
      name,
      csrf: token(),
      expiresAt: new Date(Date.now() + 8 * 3600000),
    };
    await store.putSession(tokenHash(secret), session);
    reply.setCookie("a2ui_session", secret, { ...cookie, maxAge: 8 * 3600 });
  };
  let discovery: Promise<oidc.Configuration> | undefined;
  const provider = () =>
    (discovery ??= oidc.discovery(
      new URL(config.OIDC_ISSUER!),
      config.OIDC_CLIENT_ID!,
      config.OIDC_CLIENT_SECRET,
      undefined,
      {
        execute: config.OIDC_ISSUER!.startsWith("http://")
          ? [oidc.allowInsecureRequests]
          : [],
      },
    ));
  app.get("/v1/session", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const session = await read(req);
    return session
      ? {
          authenticated: true,
          userId: session.userId,
          name: session.name,
          csrf: session.csrf,
          authMode: config.AUTH_MODE,
          adapter: adapterName,
        }
      : {
          authenticated: false,
          authMode: config.AUTH_MODE,
          adapter: adapterName,
        };
  });
  app.post("/auth/demo", async (req, reply) => {
    if (config.AUTH_MODE !== "demo") throw new AppError(404, "not_found");
    if (req.headers.origin !== new URL(config.PUBLIC_URL).origin)
      throw new AppError(403, "origin");
    await signIn(reply, "demo-user", "Локальный демонстрационный пользователь");
    return { ok: true };
  });
  app.get("/auth/login", async (_req, reply) => {
    if (custom) {
      if (!custom.login) throw new AppError(501, "login_not_supported");
      return custom.login(_req, reply);
    }
    if (config.AUTH_MODE !== "oidc") return reply.redirect("/");
    const client = await provider();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const key = token();
    await store.loginAttempt(tokenHash(key), { verifier, state, nonce });
    reply.setCookie("a2ui_oidc", key, { ...cookie, maxAge: 600 });
    return reply.redirect(
      oidc.buildAuthorizationUrl(client, {
        redirect_uri: new URL("/auth/callback", config.PUBLIC_URL).href,
        scope: "openid profile",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      }).href,
    );
  });
  app.get("/auth/callback", async (req, reply) => {
    if (config.AUTH_MODE !== "oidc") throw new AppError(404, "not_found");
    const key = req.cookies.a2ui_oidc;
    if (!key) throw new AppError(401, "login_state");
    const attempt = await store.loginAttempt(tokenHash(key));
    reply.clearCookie("a2ui_oidc", cookie);
    if (!attempt) throw new AppError(401, "login_state");
    const client = await provider();
    const tokens = await oidc.authorizationCodeGrant(
      client,
      new URL(req.url, config.PUBLIC_URL),
      {
        pkceCodeVerifier: attempt.verifier,
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (!claims?.sub) throw new AppError(401, "login_claims");
    await signIn(
      reply,
      `${config.OIDC_ISSUER}|${claims.sub}`,
      String(claims.name ?? claims.preferred_username ?? "Пользователь"),
    );
    return reply.redirect("/");
  });
  app.post("/auth/logout", async (req, reply) => {
    const user = await requireUser(req);
    csrf(req, user);
    if (custom) {
      if (!custom.logout) throw new AppError(501, "logout_not_supported");
      await custom.logout(req, reply, user);
      return { ok: true };
    }
    await store.revokeSession(tokenHash(req.cookies.a2ui_session!));
    reply.clearCookie("a2ui_session", cookie);
    return { ok: true };
  });
  return { read, requireUser, csrf };
}
