import type { ApiError, EnhanceDescriptionInput, PdfLink } from "../../shared/types";
import { isConflict, isOutcomeUnknown } from "../api/client";
import { createHttpApi } from "../api/http";

const base = "https://scope-diff.invalid/api/v1";
const fixtureToken = "http-fixture-token";
const dictation: EnhanceDescriptionInput = {
  kind: "change_item", title: "Макет", currentText: "Основное описание.", dictation: "потом на телефоне", context: "Мобильный заказ",
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function response(status: number, payload?: unknown): FetchResponse {
  return {
    status, cached: false,
    json<T>() { if (payload === undefined) throw new Error("No JSON"); return payload as T; },
    text: () => JSON.stringify(payload), bytes: () => new Uint8Array([37, 80, 68, 70, 45]), dispose() {},
  };
}

function store(initial: string | null = null) {
  let value = initial;
  return { get: async () => value, set: async (_key: string, token: string) => { value = token; } };
}

async function rejects(op: () => Promise<unknown>, code: string, status: number) {
  try { await op(); } catch (error) {
    const actual = error as ApiError & { status: number };
    check(actual.status === status && actual.error?.code === code, `Invalid error for ${code}`);
    return actual;
  }
  throw new Error(`Missing error ${code}`);
}

async function requestRoutes() {
  const calls: Array<{ path: string; options: NonNullable<Parameters<typeof fetch>[1]> }> = [];
  const statuses: Record<string, number> = {
    "POST /session": 201, "POST /services": 201, "POST /orders": 201,
    "POST /services/import": 201, "POST /orders/import": 201, "POST /orders/o/proposals": 201,
    "DELETE /services/s": 204, "DELETE /orders/o": 204, "DELETE /proposals/p": 204,
  };
  const storage = store();
  const request: typeof fetch = async (url, options) => {
    check(options && url.startsWith(base), "HTTP settings missing");
    const path = url.slice(base.length);
    calls.push({ path, options });
    const isPublic = path === "/health" || path === "/session" || path.startsWith("/public/");
    check(options.headers?.Authorization === (isPublic ? undefined : `Bearer ${fixtureToken}`), "Wrong authentication scope");
    check(!url.includes(fixtureToken), "Session token in URL");
    if (path === "/session") {
      check(options.body === "{}", "Session needs an empty JSON object");
      return response(201, { token: fixtureToken });
    }
    if (options.method === "GET") check(options.cache === "no-store", "GET must read fresh data");
    if (path === "/versions/v%20pdf/pdf-link") {
      check(options.method === "POST" && options.body === "{}", "Expected an empty JSON object for the PDF link");
      return response(200, { url: "https://scope-diff.invalid/temporary.pdf", expiresAt: "2026-11-28T12:10:00Z" } satisfies PdfLink);
    }
    if (path === "/ai/enhance-description") {
      check(options.method === "POST" && options.headers?.["Content-Type"] === "application/json", "Expected JSON for dictation");
      check(options.body === JSON.stringify(dictation), "Dictation fields did not reach the transport");
      return response(200, { text: "Основное описание. Затем проверить на телефоне." });
    }
    const status = statuses[`${options.method} ${path}`] ?? 200;
    if (status === 204) return response(204);
    if (["/orders", "/services", "/services/import", "/orders/o/proposals"].includes(path) &&
        (options.method === "GET" || path === "/services/import")) return response(status, []);
    return response(status, { status: "ok", proposal: { shareUrl: "https://scope-diff.invalid/share/share-fixture" } });
  };
  const api = createHttpApi(base, { request, storage, online: () => true });
  await api.health();
  const lists = await Promise.all([api.listOrders(), api.listServices()]);
  check(lists.every(Array.isArray), "List payloads must remain arrays");
  check(calls.filter(({ path }) => path === "/session").length === 1, "Concurrent requests opened duplicate sessions");
  check(await storage.get() === fixtureToken, "Session was not saved");

  await api.createService({ name: "Сервис" });
  await api.getService("s");
  await api.updateService("s", { description: "Описание" });
  await api.deleteService("s");
  await api.createOrder({ title: "Заказ" });
  await api.getOrder("o");
  await api.updateOrder("o", { status: "completed" });
  await api.deleteOrder("o");
  await api.listProposals("o");
  await api.getProposal("p");
  await api.updateProposal("p", { expectedVersionId: "v", content: { title: "Работы", conditions: "", items: [], deadline: null, comment: null } });
  const published = await api.publishProposal("p", { expectedVersionId: "v", format: "link" });
  check(published.proposal.shareUrl === "https://scope-diff.invalid/share/share-fixture", "Publish response lost public URL");
  await api.approveProposal("p", { expectedVersionId: "v" });
  await api.rejectProposal("p", { expectedVersionId: "v" });
  await api.revokeLink("p", { expectedVersionId: "v" });
  await api.deleteProposal("p");
  check(await api.temporaryPdfUrl("v pdf") === "https://scope-diff.invalid/temporary.pdf", "PDF link response lost its URL");
  check((await api.getVersionPdf("v")).bytes()[0] === 37, "PDF response must stay binary");
  await api.getPublicProposal("share fixture");
  await api.respondPublic("share fixture", { action: "approve", expectedVersionId: "v" });
  check((await api.enhanceDescription(dictation)).text.endsWith("на телефоне."), "Dictation response text was lost");
  const png = new File(0, "пример.png", 1024);
  await api.importServices({ text: "Одна услуга", files: [png] });
  await api.importOrder({ text: "Переписка", files: [png], serviceId: "s" });
  await api.createProposal("o", { files: [png] });
  await api.reviseProposal("p", { text: "Замечания", expectedVersionId: "v" });

  const paths = calls.map(({ path, options }) => `${options.method} ${path}`);
  for (const required of [
    "GET /health", "GET /services", "POST /services", "GET /services/s", "PATCH /services/s", "DELETE /services/s",
    "GET /orders", "POST /orders", "GET /orders/o", "PATCH /orders/o", "DELETE /orders/o", "GET /orders/o/proposals",
    "GET /proposals/p", "PATCH /proposals/p", "POST /proposals/p/publish", "POST /proposals/p/approve", "POST /proposals/p/reject",
    "POST /proposals/p/revoke-link", "DELETE /proposals/p", "POST /versions/v%20pdf/pdf-link", "GET /versions/v/pdf", "GET /public/share%20fixture",
    "POST /public/share%20fixture/respond", "POST /services/import", "POST /orders/import", "POST /orders/o/proposals", "POST /proposals/p/revise",
  ]) check(paths.includes(required), `Missing ${required}`);
  for (const { path, options } of calls.slice(-4)) {
    check(options.body instanceof FormData, `Expected native FormData for ${path}`);
    check(!options.headers?.["Content-Type"] && options.timeout === 90_000, `Wrong multipart settings for ${path}`);
  }
  const approve = calls.find(({ path }) => path.endsWith("/approve"));
  check(approve?.options.body === '{"expectedVersionId":"v"}', "Missing version on approval");
  await createHttpApi(base, { request, storage, online: () => true }).listOrders();
  check(calls.filter(({ path }) => path === "/session").length === 1, "Restart did not reuse saved session");
}

async function failedRequests() {
  let connected = true;
  let outbound = 0;
  let result = response(409, { error: { code: "VERSION_CONFLICT", message: "Версия изменилась" } });
  const request: typeof fetch = async (url, options) => {
    outbound++;
    check(!url.endsWith("/session"), "Saved token was discarded after error");
    check(options?.headers?.Authorization === `Bearer ${fixtureToken}`, "Saved token was replaced");
    return result;
  };
  const api = createHttpApi(base, { request, storage: store(fixtureToken), online: () => connected });
  check(isConflict(await rejects(() => api.approveProposal("p", { expectedVersionId: "v" }), "VERSION_CONFLICT", 409)), "Version conflict not recognized");
  result = response(409, { error: { code: "ORDER_CHANGED", message: "Заказ изменился" } });
  check(isConflict(await rejects(() => api.approveProposal("p", { expectedVersionId: "v" }), "ORDER_CHANGED", 409)), "Order conflict not recognized");
  result = response(401, { error: { code: "UNAUTHORIZED", message: fixtureToken } });
  const unauthorized = await rejects(() => api.listOrders(), "UNAUTHORIZED", 401);
  check(!unauthorized.error.message.includes(fixtureToken), "Authorization failure leaked the token");
  await rejects(() => api.listServices(), "UNAUTHORIZED", 401);
  result = response(404);
  await rejects(() => api.getOrder("missing"), "NOT_FOUND", 404);
  await rejects(() => api.enhanceDescription(dictation), "SERVICE_UNAVAILABLE", 404);
  result = response(200, { text: 123 });
  await rejects(() => api.enhanceDescription(dictation), "INVALID_RESPONSE", 200);
  result = response(429, { error: { code: "RATE_LIMITED", message: "Повторите позже" } });
  await rejects(() => api.importServices({ text: "Услуга" }), "RATE_LIMITED", 429);
  result = response(502, { error: { code: "AI_FAILED", message: "Обработка недоступна" } });
  check(!isOutcomeUnknown(await rejects(() => api.importOrder({ text: "Заказ" }), "AI_FAILED", 502)), "Known AI failure is safe to retry manually");
  result = response(200);
  await rejects(() => api.listServices(), "INVALID_RESPONSE", 200);
  connected = false;
  const beforeOffline = outbound;
  check(!isOutcomeUnknown(await rejects(() => api.deleteOrder("o"), "OFFLINE", 0)), "Offline preflight sent a write");
  check(outbound === beforeOffline, "Offline preflight touched the transport");
  connected = true;
  result = response(0);
  const beforeTimeout = outbound;
  check(isOutcomeUnknown(await rejects(() => api.deleteOrder("o"), "NETWORK_ERROR", 0)), "Transport failure must flag uncertain write");
  check(outbound === beforeTimeout + 1, "Write was retried automatically");
  await rejects(() => api.importServices({ files: [new File(0, "large.png", 5 * 1024 * 1024 + 1)] }), "FILE_TOO_LARGE", 413);
  await rejects(() => api.importServices({ files: Array.from({ length: 4 }, () => new File(0, "photo.png", 100)) }), "FILE_TOO_LARGE", 413);
  check(outbound === beforeTimeout + 1, "Invalid files reached the network");
}

async function sessionRecovery() {
  let creates = 0;
  const request: typeof fetch = async (url) => {
    if (!url.endsWith("/session")) return response(200, []);
    creates++;
    if (creates === 1) throw new Error("Simulated timeout");
    return response(201, { token: fixtureToken });
  };
  const api = createHttpApi(base, { request, storage: store(), online: () => true });
  await rejects(() => api.listOrders(), "NETWORK_ERROR", 0);
  await rejects(() => api.listServices(), "NETWORK_ERROR", 0);
  check(creates === 1, "Initial session was retried without an explicit action");
  api.allowInitialSessionRetry?.();
  await api.listOrders();
  check(Number(creates) === 2, "Explicit retry did not recover the initial session");

  let saveAttempts = 0;
  const failingStorage = { get: async () => null, set: async () => {
    if (++saveAttempts === 1) throw new Error("Simulated secure storage failure");
  } };
  const secure = createHttpApi(base, { request, storage: failingStorage, online: () => true });
  await rejects(() => secure.listOrders(), "SESSION_STORAGE", 0);
  await secure.listOrders();
  check(saveAttempts === 2 && Number(creates) === 3, "Secure storage retry opened another session");
  await rejects(() => createHttpApi("", { request, storage: store(), online: () => true }).listOrders(), "API_NOT_CONFIGURED", 0);
}

const result = signal("Проверки HTTP выполняются");
UIScreen(UIText(() => result.value)).named("http-checks").onOpen(async () => {
  try {
    await requestRoutes();
    await failedRequests();
    await sessionRecovery();
    result.value = "Проверки HTTP пройдены";
  } catch (error) {
    result.value = error instanceof Error ? error.message : "Ошибка проверки HTTP";
  }
}).open();
