import type {
  ApiError, ID, Order, OrderDetail, OrderImportResult, OrderSummary, Proposal, ProposalDetail, ProposalResult,
  PublicProposal, PublicResponse, Service, SessionResponse, VersionAction,
} from "../../shared/types";
import { validateAiInput } from "./ai-input";
import type { AiInput, ApiClient } from "./client";

export interface HttpApi extends ApiClient {
  health(): Promise<{ status: "ok" }>;
  initializeSession(): Promise<void>;
  listProposals(orderId: ID): Promise<Proposal[]>;
  revokeLink(id: ID, input: VersionAction): Promise<ProposalResult>;
  deleteProposal(id: ID): Promise<void>;
  getVersionPdf(versionId: ID): Promise<FetchResponse>;
  getPublicProposal(token: string): Promise<PublicProposal>;
  respondPublic(token: string, input: PublicResponse): Promise<PublicProposal>;
}

type Dependencies = {
  request?: typeof fetch;
  storage?: Pick<typeof secureStorage, "get" | "set">;
  online?: () => boolean;
};

type Request = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  status: 200 | 201 | 204;
  access?: "public" | "session";
  json?: object;
  form?: FormData;
  accept?: string;
  list?: boolean;
};

class HttpError extends Error implements ApiError {
  readonly error: ApiError["error"];

  constructor(readonly status: number, code: string, message: string, readonly outcomeUnknown = false) {
    super(message);
    this.error = { code, message };
  }
}

const statusErrors: Record<number, [string, string]> = {
  400: ["BAD_INPUT", "Проверьте введённые данные."],
  401: ["UNAUTHORIZED", "Сервер не принял сохранённую сессию."],
  404: ["NOT_FOUND", "Запись не найдена или недоступна."],
  409: ["CONFLICT", "Данные изменились. Обновите экран перед повторной попыткой."],
  413: ["FILE_TOO_LARGE", "Проверьте размер и количество скриншотов."],
  422: ["VALIDATION_ERROR", "Сервер не смог обработать введённые данные."],
  429: ["RATE_LIMITED", "Слишком много запросов. Попробуйте немного позже."],
  502: ["AI_FAILED", "Не удалось обработать запрос с помощью AI. Попробуйте ещё раз."],
  503: ["SERVICE_UNAVAILABLE", "Сервис временно недоступен. Попробуйте позже."],
};

function segment(value: string) {
  if (!value || value === "." || value === "..") throw new HttpError(400, "BAD_INPUT", "Не удалось открыть запись.");
  return encodeURIComponent(value);
}

function requireToken(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(value)) {
    throw new HttpError(0, "INVALID_SESSION", "Не удалось прочитать токен сессии.");
  }
  return value;
}

function reportFailure(response: FetchResponse, mayHaveWritten: boolean, secrets: readonly string[]) {
  const status = response.status;
  const [defaultCode, defaultMessage] = statusErrors[status] ?? ["REQUEST_FAILED", "Сервер не смог обработать запрос."];
  if (status === 401) return new HttpError(status, defaultCode, defaultMessage);

  let body: Partial<ApiError>["error"];
  try { body = response.json<Partial<ApiError>>()?.error; } catch { /* A proxy may send HTML. */ }
  const code = typeof body?.code === "string" && /^[A-Z_]{1,64}$/.test(body.code) ? body.code : defaultCode;
  const unknown = mayHaveWritten && (status === 408 || status === 504 || (status >= 500 && !body));
  const reported = typeof body?.message === "string" ? body.message.trim() : "";
  const message = secrets.reduce((text, secret) => text.split(secret).join("[скрыто]"), reported).slice(0, 360);
  return new HttpError(status, code, unknown ? uncertainMessage : message || defaultMessage, unknown);
}

const uncertainMessage = "Сервер не подтвердил результат. Проверьте данные перед повторной отправкой.";

function toForm(input: AiInput, extra?: { serviceId: ID } | { expectedVersionId: ID }) {
  const { text, files } = validateAiInput(input);
  const form = new FormData();
  if (text) form.append("text", text);
  for (const file of files) form.append("files", file);
  if (extra && "serviceId" in extra) form.append("serviceId", extra.serviceId);
  if (extra && "expectedVersionId" in extra) form.append("expectedVersionId", extra.expectedVersionId);
  return form;
}

export function createHttpApi(configuredBaseUrl: string, dependencies: Dependencies = {}): HttpApi {
  const baseUrl = configuredBaseUrl.trim().replace(/\/+$/, "");
  const sessionKey = `scope.diff.session.v1:${baseUrl}`;
  const request = dependencies.request ?? fetch;
  const storage = dependencies.storage ?? secureStorage;
  const online = dependencies.online ?? (() => device.online);
  let token: string | undefined;
  let tokenNeedsSave = false;
  let initialSessionFailure: unknown;
  let openingSession: Promise<string> | undefined;

  function ensureConfiguration() {
    if (!/^https:\/\/(?:[a-z0-9.-]+|\[[\da-f:]+\])(?::\d+)?\/api\/v1$/i.test(baseUrl)) {
      throw new HttpError(0, "API_NOT_CONFIGURED", "Укажите HTTPS-адрес сервера ScopeDiff с путём /api/v1 в настройках сборки.");
    }
  }

  async function send(path: string, spec: Request, privateToken?: string, publicToken?: string) {
    ensureConfiguration();
    if (online() === false) throw new HttpError(0, "OFFLINE", "Нет подключения к интернету. Проверьте сеть и повторите запрос.");

    const headers: Record<string, string> = { Accept: spec.accept ?? "application/json" };
    if (privateToken) headers.Authorization = `Bearer ${privateToken}`;
    if (spec.json !== undefined) headers["Content-Type"] = "application/json";
    const body = spec.form ?? (spec.json === undefined ? undefined : JSON.stringify(spec.json));
    const mayHaveWritten = spec.method !== "GET" && spec.access !== "session";
    let response: FetchResponse | undefined;
    try {
      response = await request(`${baseUrl}${path}`, {
        method: spec.method, headers, body, timeout: spec.form ? 90_000 : 20_000,
        cache: spec.method === "GET" ? "no-store" : undefined,
      });
    } catch { /* The SDK reports timeouts and transport errors through the same channel. */ }
    if (!response || response.status <= 0) {
      throw new HttpError(0, "NETWORK_ERROR", mayHaveWritten ? uncertainMessage : "Не удалось связаться с сервером ScopeDiff. Проверьте подключение.", mayHaveWritten);
    }
    if (response.status !== spec.status) {
      if (response.status >= 200 && response.status < 300) throw unexpectedResponse(response.status, mayHaveWritten);
      throw reportFailure(response, mayHaveWritten, [privateToken, publicToken].filter((value): value is string => Boolean(value)));
    }
    return response;
  }

  function unexpectedResponse(status: number, mayHaveWritten: boolean) {
    return new HttpError(status, "INVALID_RESPONSE", mayHaveWritten ? uncertainMessage : "Сервер вернул неожиданный ответ.", mayHaveWritten);
  }

  function decode<T>(response: FetchResponse, spec: Request): T {
    const mayHaveWritten = spec.method !== "GET" && spec.access !== "session";
    let value: T;
    try { value = response.json<T>(); } catch { throw unexpectedResponse(response.status, mayHaveWritten); }
    if (typeof value !== "object" || value === null || Array.isArray(value) !== Boolean(spec.list)) {
      throw unexpectedResponse(response.status, mayHaveWritten);
    }
    return value;
  }

  async function restoreOrCreate(): Promise<string> {
    if (!token) {
      let saved: string | null;
      try { saved = await storage.get(sessionKey); } catch {
        throw new HttpError(0, "SESSION_STORAGE", "Не удалось открыть защищённое хранилище сессии.");
      }
      if (saved !== null) token = requireToken(saved);
      else {
        if (initialSessionFailure) throw initialSessionFailure;
        const spec: Request = { method: "POST", status: 201, access: "session", json: {} };
        try {
          token = requireToken(decode<SessionResponse>(await send("/session", spec), spec).token);
          tokenNeedsSave = true;
        } catch (error) {
          initialSessionFailure = error;
          throw error;
        }
      }
    }
    if (tokenNeedsSave) {
      try { await storage.set(sessionKey, token); } catch {
        throw new HttpError(0, "SESSION_STORAGE", "Не удалось сохранить сессию в защищённом хранилище.");
      }
      tokenNeedsSave = false;
    }
    return token;
  }

  function sessionToken() {
    ensureConfiguration();
    if (token && !tokenNeedsSave) return Promise.resolve(token);
    if (!openingSession) openingSession = restoreOrCreate().finally(() => { openingSession = undefined; });
    return openingSession;
  }

  async function sendJson<T>(path: string, spec: Request, publicToken?: string): Promise<T> {
    const privateToken = spec.access === "public" ? undefined : await sessionToken();
    return decode<T>(await send(path, spec, privateToken, publicToken), spec);
  }

  const get = <T>(path: string, list = false) => sendJson<T>(path, { method: "GET", status: 200, list });
  const create = <T>(path: string, json: object) => sendJson<T>(path, { method: "POST", status: 201, json });
  const update = <T>(path: string, json: object) => sendJson<T>(path, { method: "PATCH", status: 200, json });
  const action = <T>(path: string, json: object) => sendJson<T>(path, { method: "POST", status: 200, json });
  async function remove(path: string) { await send(path, { method: "DELETE", status: 204 }, await sessionToken()); }
  const proposal = (id: ID) => `/proposals/${segment(id)}`;
  const order = (id: ID) => `/orders/${segment(id)}`;
  const service = (id: ID) => `/services/${segment(id)}`;

  return {
    demo: false,
    allowInitialSessionRetry() { initialSessionFailure = undefined; },
    async initializeSession() { await sessionToken(); },
    health: () => sendJson("/health", { method: "GET", status: 200, access: "public" }),
    listServices: () => get<Service[]>("/services", true),
    getService: (id) => get<Service>(service(id)),
    createService: (input) => create<Service>("/services", input),
    updateService: (id, input) => update<Service>(service(id), input),
    deleteService: (id) => remove(service(id)),
    async importServices(input) {
      return sendJson<Service[]>("/services/import", { method: "POST", status: 201, form: toForm(input), list: true });
    },
    listOrders: () => get<OrderSummary[]>("/orders", true),
    getOrder: (id) => get<OrderDetail>(order(id)),
    createOrder: (input) => create<Order>("/orders", input),
    updateOrder: (id, input) => update<Order>(order(id), input),
    deleteOrder: (id) => remove(order(id)),
    async importOrder(input) {
      const extra = input.serviceId === undefined ? undefined : { serviceId: input.serviceId };
      return sendJson<OrderImportResult>("/orders/import", { method: "POST", status: 201, form: toForm(input, extra) });
    },
    listProposals: (orderId) => get<Proposal[]>(`${order(orderId)}/proposals`, true),
    getProposal: (id) => get<ProposalDetail>(proposal(id)),
    async createProposal(orderId, input) {
      return sendJson<ProposalResult>(`${order(orderId)}/proposals`, { method: "POST", status: 201, form: toForm(input) });
    },
    async reviseProposal(id, input) {
      return sendJson<ProposalResult>(`${proposal(id)}/revise`, {
        method: "POST", status: 200, form: toForm(input, { expectedVersionId: input.expectedVersionId }),
      });
    },
    updateProposal: (id, input) => update<ProposalResult>(proposal(id), input),
    publishProposal: (id, input) => action<ProposalResult>(`${proposal(id)}/publish`, input),
    approveProposal: (id, input) => action<ProposalResult>(`${proposal(id)}/approve`, input),
    rejectProposal: (id, input) => action<ProposalResult>(`${proposal(id)}/reject`, input),
    revokeLink: (id, input) => action<ProposalResult>(`${proposal(id)}/revoke-link`, input),
    deleteProposal: (id) => remove(proposal(id)),
    async getVersionPdf(versionId) {
      return send(`/versions/${segment(versionId)}/pdf`, { method: "GET", status: 200, accept: "application/pdf" }, await sessionToken());
    },
    getPublicProposal: (token) => sendJson<PublicProposal>(`/public/${segment(token)}`, { method: "GET", status: 200, access: "public" }, token),
    respondPublic: (token, input) => sendJson<PublicProposal>(`/public/${segment(token)}/respond`, { method: "POST", status: 200, access: "public", json: input }, token),
  };
}
