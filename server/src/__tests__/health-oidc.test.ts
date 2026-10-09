import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: vi.fn(() => undefined),
  toDevServerHealthStatus: vi.fn(),
}));

const { healthRoutes } = await import("../routes/health.js");

const OIDC_ENV = {
  PAPERCLIP_AUTH_OIDC_ISSUER: "https://sso.example.cn/realms/digital-workforce",
  PAPERCLIP_AUTH_OIDC_CLIENT_ID: "paperclip",
  PAPERCLIP_AUTH_OIDC_CLIENT_SECRET: "client-secret-value",
  PAPERCLIP_AUTH_OIDC_ORG_COMPANY_MAP: JSON.stringify({ acme: "5facf42d-f31f-4698-9bc9-e38f876b1579" }),
  PAPERCLIP_AUTH_OIDC_LABEL: "使用企业账号登录",
};

function authenticatedDb(): Db {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      })),
    })),
  } as unknown as Db;
}

function createApp(runtimeEnv: Record<string, string | undefined>, actorType: "none" | "board" = "none") {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor =
      actorType === "board" ? { type: "board", source: "session", userId: "user-a" } : { type: "none", source: "none" };
    next();
  });
  app.use(
    "/health",
    healthRoutes(authenticatedDb(), {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      companyDeletionEnabled: false,
      runtimeEnv,
    }),
  );
  return app;
}

describe("health auth.oidc", () => {
  it("tells anonymous callers that enterprise sign-in is available", async () => {
    const res = await request(createApp(OIDC_ENV)).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({
      oidc: { enabled: true, providerId: "keycloak", label: "使用企业账号登录" },
    });
  });

  it("includes the same public sign-in info for signed-in board callers", async () => {
    const res = await request(createApp(OIDC_ENV, "board")).get("/health");

    expect(res.body.auth).toEqual({
      oidc: { enabled: true, providerId: "keycloak", label: "使用企业账号登录" },
    });
  });

  it("never exposes the issuer, client id, client secret or organization map", async () => {
    const res = await request(createApp(OIDC_ENV)).get("/health");
    const body = JSON.stringify(res.body);

    expect(body).not.toContain("sso.example.cn");
    expect(body).not.toContain("client-secret-value");
    expect(body).not.toContain("5facf42d-f31f-4698-9bc9-e38f876b1579");
    expect(body).not.toContain("\"paperclip\"");
  });

  it("omits the auth block entirely when OIDC is not configured", async () => {
    const res = await request(createApp({})).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("auth");
  });
});
