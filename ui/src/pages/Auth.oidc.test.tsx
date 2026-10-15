// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "./Auth";

const getSessionMock = vi.hoisted(() => vi.fn());
const signInEmailMock = vi.hoisted(() => vi.fn());
const signUpEmailMock = vi.hoisted(() => vi.fn());
const signInSocialMock = vi.hoisted(() => vi.fn());
const healthMock = vi.hoisted(() => vi.fn());
const redirectToSsoMock = vi.hoisted(() => vi.fn());

vi.mock("../api/health", () => ({ healthApi: { get: () => healthMock() } }));
vi.mock("@/lib/cloud-sign-in", () => ({
  beginCloudSignIn: vi.fn(),
  clearCloudSignInAttempt: vi.fn(),
}));
vi.mock("@/lib/sso-redirect", () => ({
  redirectToSso: (url: string) => redirectToSsoMock(url),
}));
vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
    signInEmail: (input: unknown) => signInEmailMock(input),
    signUpEmail: (input: unknown) => signUpEmailMock(input),
    signInSocial: (input: unknown) => signInSocialMock(input),
  },
}));
vi.mock("@/components/AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn(), toggleTheme: vi.fn() }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: null,
    companies: [],
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  flushSync(() => {});
}

const OIDC_HEALTH = {
  status: "ok",
  deploymentMode: "authenticated",
  auth: { oidc: { enabled: true, providerId: "keycloak", label: "使用企业账号登录" } },
};

describe("AuthPage enterprise sign-in", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getSessionMock.mockResolvedValue(null);
    healthMock.mockResolvedValue(OIDC_HEALTH);
    signInSocialMock.mockResolvedValue({ url: "https://sso.example.cn/realms/dw/protocol/openid-connect/auth?x=1" });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function mount(path = "/auth") {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/auth" element={<AuthPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  function ssoButton() {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "使用企业账号登录",
    );
  }

  it("shows the enterprise sign-in button with the configured label", async () => {
    const root = await mount();
    expect(ssoButton()).toBeDefined();
    await act(() => root.unmount());
  });

  it("starts Keycloak sign-in and redirects to the returned URL", async () => {
    const root = await mount("/auth?next=%2FSTE%2Fdashboard");

    await act(async () => {
      ssoButton()!.click();
    });
    await flushReact();

    expect(signInSocialMock).toHaveBeenCalledWith({
      provider: "keycloak",
      callbackURL: "/STE/dashboard",
      errorCallbackURL: "/auth?next=%2FSTE%2Fdashboard",
    });
    expect(redirectToSsoMock).toHaveBeenCalledWith(
      "https://sso.example.cn/realms/dw/protocol/openid-connect/auth?x=1",
    );
    await act(() => root.unmount());
  });

  it("explains an organization rejection", async () => {
    const root = await mount("/auth?error=org_not_allowed");
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "您的账号未被授权访问此平台，请联系管理员",
    );
    await act(() => root.unmount());
  });

  it("shows a generic retry message for other sign-in errors", async () => {
    const root = await mount("/auth?error=invalid_code");
    expect(container.querySelector("[role='alert']")?.textContent).toContain("企业登录失败，请重试");
    await act(() => root.unmount());
  });

  it("reports an unreachable sign-in service instead of hanging", async () => {
    signInSocialMock.mockRejectedValue(new Error("Failed to fetch"));
    const root = await mount();

    await act(async () => {
      ssoButton()!.click();
    });
    await flushReact();

    expect(redirectToSsoMock).not.toHaveBeenCalled();
    expect(container.querySelector("[role='alert']")?.textContent).toContain("企业登录服务暂时不可用");
    expect(ssoButton()?.disabled).toBe(false);
    await act(() => root.unmount());
  });

  function breakGlassToggle() {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "管理员应急登录",
    );
  }

  it("folds the password form behind the break-glass admin entry and hides sign-up", async () => {
    const root = await mount();

    expect(breakGlassToggle()).toBeDefined();
    expect(breakGlassToggle()!.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("input[name='email']")).toBeNull();
    expect(container.querySelector("input[name='password']")).toBeNull();
    expect(container.textContent).not.toContain("Need an account?");
    expect(container.textContent).not.toContain("Create one");
    await act(() => root.unmount());
  });

  it("lets the break-glass admin sign in with a password after expanding", async () => {
    signInEmailMock.mockResolvedValue(undefined);
    const root = await mount();

    await act(async () => {
      breakGlassToggle()!.click();
    });
    expect(breakGlassToggle()!.getAttribute("aria-expanded")).toBe("true");

    const email = container.querySelector<HTMLInputElement>("input[name='email']")!;
    const password = container.querySelector<HTMLInputElement>("input[name='password']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(email, "admin@example.cn");
      email.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(password, "BreakGlass#2026");
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    expect(signInEmailMock).toHaveBeenCalledWith({ email: "admin@example.cn", password: "BreakGlass#2026" });
    expect(container.textContent).not.toContain("Need an account?");
    await act(() => root.unmount());
  });

  it("keeps the upstream page unchanged when enterprise sign-in is off", async () => {
    healthMock.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    const root = await mount();

    expect(ssoButton()).toBeUndefined();
    expect(container.querySelector("input[name='email']")).not.toBeNull();
    expect(container.textContent).toContain("Need an account?");
    await act(() => root.unmount());
  });

  it("shows the configured brand instead of the Paperclip lockup", async () => {
    healthMock.mockResolvedValue({
      ...OIDC_HEALTH,
      auth: {
        ...OIDC_HEALTH.auth,
        brand: { name: "FiveGuys 数字员工平台", logoUrl: "https://agent.example.cn/brand/logo.png" },
      },
    });
    const root = await mount();

    expect(container.querySelector("h1")?.textContent).toBe("登录 FiveGuys 数字员工平台");
    expect(container.textContent).toContain("使用企业账号登录，访问数字员工平台");
    const logo = container.querySelector("img");
    expect(logo?.getAttribute("src")).toBe("https://agent.example.cn/brand/logo.png");
    expect(logo?.getAttribute("alt")).toBe("FiveGuys 数字员工平台");
    expect(logo?.parentElement?.textContent).toBe("");
    expect(container.querySelector("svg[aria-label='Paperclip']")).toBeNull();
    expect(document.title).toBe("FiveGuys 数字员工平台");
    expect(ssoButton()).toBeDefined();
    await act(() => root.unmount());
  });

  it("shows the brand name without a logo when none is configured", async () => {
    healthMock.mockResolvedValue({
      ...OIDC_HEALTH,
      auth: { ...OIDC_HEALTH.auth, brand: { name: "FiveGuys 数字员工平台" } },
    });
    const root = await mount();

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("h1")?.previousElementSibling?.textContent).toBe("FiveGuys 数字员工平台");
    expect(container.querySelector("h1")?.textContent).toBe("登录 FiveGuys 数字员工平台");
    await act(() => root.unmount());
  });

  it("keeps the Paperclip lockup and title without a brand", async () => {
    const root = await mount();

    expect(container.querySelector("h1")?.textContent).toBe("Sign in to Paperclip");
    expect(container.querySelector("svg[aria-label='Paperclip']")).not.toBeNull();
    await act(() => root.unmount());
  });
});
