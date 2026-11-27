import type {
  ApiError, ChangeItem, DateOnly, ID, Order, OrderInput, Proposal, ProposalContent, ProposalContentInput,
  ProposalResult, ProposalVersion, Service, ServiceInput,
} from "../../shared/types";
import { demoOrders, demoServices } from "../demo-data";
import type { AiInput, ApiClient } from "./client";
import { aiExamples, exampleChanges, exampleOrder, exampleServices } from "./mock-ai";
import { isOpen, priceSummary } from "../proposals/model";

type State = { services: Service[]; orders: Order[]; proposals: Proposal[]; versions: ProposalVersion[] };
const storageKey = "scope.diff.mock.v1";
const maxFileSize = 5 * 1024 * 1024;

class MockError extends Error implements ApiError {
  readonly error: ApiError["error"];

  constructor(readonly status: number, code: string, message: string) {
    super(message);
    this.error = { code, message };
  }
}

function readState(): State {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === null) return { services: demoServices, orders: demoOrders, proposals: [], versions: [] };
    const state = JSON.parse(saved) as State;
    if ([state.services, state.orders, state.proposals, state.versions].every(Array.isArray)) return state;
  } catch {
    // Keep the original record so a failed read cannot overwrite local data.
  }
  throw new MockError(503, "SERVICE_UNAVAILABLE", "Не удалось прочитать данные на этом устройстве.");
}

function mutate<T>(change: (state: State) => T): T {
  const state = readState();
  const result = change(state);
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    throw new MockError(503, "SERVICE_UNAVAILABLE", "Не удалось сохранить данные на этом устройстве.");
  }
  return result;
}

function newId(): ID {
  // These identifiers address local mock records, not authenticated sessions.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const digit = Math.floor(Math.random() * 16);
    return (character === "x" ? digit : (digit & 3) | 8).toString(16);
  });
}

function find<T extends { id: ID }>(rows: readonly T[], id: ID, message: string): T {
  const row = rows.find((item) => item.id === id);
  if (!row) throw new MockError(404, "NOT_FOUND", message);
  return row;
}

function byUpdatedAt<T extends { updatedAt: string }>(a: T, b: T) {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function openProposal(proposals: readonly Proposal[], orderId: ID) {
  return proposals.find((item) => item.orderId === orderId && isOpen(item.status));
}

function validateText(value: string, label: string, max: number, required = false) {
  const text = value.trim();
  if (required && !text) throw new MockError(422, "VALIDATION_ERROR", `Заполните поле «${label}».`);
  if ([...text].length > max) throw new MockError(422, "VALIDATION_ERROR", `В поле «${label}» допустимо до ${max} символов.`);
  return text;
}

function validDate(value: DateOnly | null): DateOnly | null {
  if (value === null) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-") || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new MockError(422, "VALIDATION_ERROR", "Укажите действительную дату срока.");
  }
  return value;
}

function serviceData(input: ServiceInput): ServiceInput {
  return { name: validateText(input.name, "Название", 120, true), description: validateText(input.description, "Описание", 12000) };
}

function orderData(input: OrderInput): OrderInput {
  return {
    title: validateText(input.title, "Название", 160, true),
    agreements: validateText(input.agreements, "Договорённости", 12000),
    completedWork: validateText(input.completedWork, "Выполненные работы", 12000),
    deadline: validDate(input.deadline),
    serviceId: input.serviceId,
  };
}

function snapshot(state: State, id: ID | null) {
  return id === null ? null : { ...find(state.services, id, "Услуга не найдена.") };
}

function insertOrder(state: State, input: OrderInput): Order {
  const now = new Date().toISOString();
  const order: Order = {
    ...orderData(input), id: newId(), serviceSnapshot: snapshot(state, input.serviceId),
    status: "active", revision: 1, createdAt: now, updatedAt: now,
  };
  state.orders = [order, ...state.orders];
  return order;
}

function aiText(input: AiInput) {
  const text = input.text?.trim() ?? "";
  const files = input.files ?? [];
  if (!text && !files.length) throw new MockError(400, "BAD_INPUT", "Добавьте текст или хотя бы один скриншот.");
  if (files.length > 3 || files.some((file) => file.size > maxFileSize)) {
    throw new MockError(413, "FILE_TOO_LARGE", "Можно добавить до трёх скриншотов, каждый до 5 МБ.");
  }
  // The client SDK exposes the name and size. The future HTTP server must inspect the bytes.
  if (files.some((file) => !/\.(png|jpe?g|webp)$/i.test(file.name) || file.size <= 0)) {
    throw new MockError(400, "BAD_INPUT", "Выберите изображения в формате PNG, JPEG или WebP.");
  }
  return text;
}

function proposalContent(input: ProposalContentInput, previous?: ProposalVersion): ProposalContent {
  if (!input.items.length) throw new MockError(422, "VALIDATION_ERROR", "Добавьте хотя бы одну работу в предложение.");
  const seen = new Set<ID>();
  const items: ChangeItem[] = input.items.map((item) => {
    if (item.id !== null && (seen.has(item.id) || !previous?.items.some((entry) => entry.id === item.id))) {
      throw new MockError(422, "VALIDATION_ERROR", "Один из пунктов отсутствует в текущей версии или указан дважды.");
    }
    const id = item.id ?? newId();
    seen.add(id);
    if (item.price !== null && (!Number.isSafeInteger(item.price) || item.price < 0)) {
      throw new MockError(422, "VALIDATION_ERROR", "Укажите стоимость в целых рублях или оставьте поле пустым.");
    }
    if (item.category !== "included" && item.category !== "extra" && item.category !== "unclear") {
      throw new MockError(422, "VALIDATION_ERROR", "Укажите категорию работы.");
    }
    return {
      ...item, id, title: validateText(item.title, "Название работы", 160, true),
      description: validateText(item.description, "Описание работы", 12000),
    };
  });
  if (!Number.isSafeInteger(priceSummary(items).known)) throw new MockError(422, "VALIDATION_ERROR", "Сумма слишком велика.");
  return {
    title: validateText(input.title, "Название предложения", 160, true), items,
    deadline: validDate(input.deadline), conditions: validateText(input.conditions, "Условия", 12000), comment: input.comment,
  };
}

function findProposal(state: State, id: ID, expectedVersionId: ID) {
  const proposal = find(state.proposals, id, "Предложение не найдено.");
  if (proposal.currentVersionId !== expectedVersionId) {
    throw new MockError(409, "VERSION_CONFLICT", "Предложение изменилось. Откройте актуальную версию и повторите действие.");
  }
  const version = find(state.versions, expectedVersionId, "Версия предложения не найдена.");
  const order = find(state.orders, proposal.orderId, "Заказ не найден.");
  return { proposal, version, order };
}

function saveProposal(state: State, order: Order, proposal: Proposal, version: ProposalVersion, writeVersion = false) {
  state.proposals = [proposal, ...state.proposals.filter((entry) => entry.id !== proposal.id)];
  if (writeVersion) state.versions = [...state.versions.filter((entry) => entry.id !== version.id), version];
  state.orders = [{ ...order, updatedAt: proposal.updatedAt }, ...state.orders.filter((entry) => entry.id !== order.id)];
  return { proposal, version };
}

function writeDraft(state: State, order: Order, input: ProposalContentInput, previous?: ProposalResult, overwrite = false) {
  const now = new Date().toISOString();
  const proposalId = previous?.proposal.id ?? newId();
  const content = proposalContent(input, previous?.version);
  const version: ProposalVersion = {
    ...content, proposalId, id: overwrite && previous ? previous.version.id : newId(),
    version: (previous?.version.version ?? 0) + (overwrite ? 0 : 1), author: "freelancer",
    baseOrderRevision: order.revision, createdAt: overwrite && previous ? previous.version.createdAt : now,
  };
  const proposal: Proposal = {
    id: proposalId, orderId: order.id, publishedVersionId: null, approvedVersionId: null, shareUrl: null,
    createdAt: now, ...previous?.proposal, title: content.title, status: "draft", currentVersionId: version.id, updatedAt: now,
  };
  return saveProposal(state, order, proposal, version, true);
}

function makeDraft(state: State, order: Order, changes: string, previous?: ProposalResult): ProposalResult {
  const approved = state.proposals.filter((item) => item.orderId === order.id && item.status === "approved")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map((item) => state.versions.find((version) => version.id === item.approvedVersionId))
    .filter((version): version is ProposalVersion => version !== undefined);
  const content = exampleChanges(changes, order, approved, previous?.version);
  if (!content.items.length || (previous && JSON.stringify(content) === JSON.stringify({
    title: previous.version.title, items: previous.version.items, deadline: previous.version.deadline,
    conditions: previous.version.conditions, comment: previous.version.comment,
  }))) {
    throw new MockError(422, "VALIDATION_ERROR", "Укажите конкретные новые пожелания.");
  }
  return writeDraft(state, order, content, previous);
}

export const mockApi: ApiClient = {
  demo: true,
  async listServices() {
    return [...readState().services].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  },
  async getService(id) { return find(readState().services, id, "Услуга не найдена."); },
  async createService(input) {
    return mutate((state) => {
      const service = { id: newId(), ...serviceData(input) };
      state.services = [...state.services, service];
      return service;
    });
  },
  async updateService(id, input) {
    return mutate((state) => {
      const current = find(state.services, id, "Услуга не найдена.");
      const service = { id, ...serviceData({ ...current, ...input }) };
      state.services = state.services.map((entry) => entry.id === id ? service : entry);
      return service;
    });
  },
  async deleteService(id) {
    mutate((state) => {
      find(state.services, id, "Услуга не найдена.");
      state.services = state.services.filter((entry) => entry.id !== id);
      state.orders = state.orders.map((order) => order.serviceId === id ? { ...order, serviceId: null } : order);
    });
  },
  async importServices(input) {
    const examples = exampleServices(aiText(input));
    if (examples.length > 15) throw new MockError(422, "VALIDATION_ERROR", "За один раз можно импортировать до 15 услуг.");
    return mutate((state) => {
      const services = examples.map((entry) => ({ id: newId(), ...serviceData(entry) }));
      state.services = [...state.services, ...services];
      return services;
    });
  },
  async listOrders() {
    const state = readState();
    return state.orders.map((order) => ({ ...order, openProposalStatus: openProposal(state.proposals, order.id)?.status ?? null }))
      .sort(byUpdatedAt);
  },
  async getOrder(id) {
    const state = readState();
    const order = find(state.orders, id, "Заказ не найден.");
    return { order, proposals: state.proposals.filter((entry) => entry.orderId === id).sort(byUpdatedAt) };
  },
  async createOrder(input) { return mutate((state) => insertOrder(state, input)); },
  async updateOrder(id, input) {
    return mutate((state) => {
      const current = find(state.orders, id, "Заказ не найден.");
      const status = input.status ?? current.status;
      if (status === "completed" && openProposal(state.proposals, id)) {
        throw new MockError(409, "OPEN_PROPOSAL_EXISTS", "Чтобы завершить заказ, сначала закройте открытое предложение.");
      }
      const data = orderData({ ...current, ...input });
      const serviceChanged = input.serviceId !== undefined &&
        (data.serviceId !== current.serviceId || (data.serviceId === null && current.serviceSnapshot !== null));
      const contextChanged = serviceChanged || data.agreements !== current.agreements ||
        data.completedWork !== current.completedWork || data.deadline !== current.deadline;
      const order: Order = {
        ...current, ...data, status, updatedAt: new Date().toISOString(),
        serviceSnapshot: serviceChanged ? snapshot(state, data.serviceId) : current.serviceSnapshot,
        revision: current.revision + (contextChanged ? 1 : 0),
      };
      state.orders = [order, ...state.orders.filter((entry) => entry.id !== id)];
      return order;
    });
  },
  async deleteOrder(id) {
    mutate((state) => {
      find(state.orders, id, "Заказ не найден.");
      const removed = new Set(state.proposals.filter((entry) => entry.orderId === id).map((entry) => entry.id));
      state.orders = state.orders.filter((entry) => entry.id !== id);
      state.proposals = state.proposals.filter((entry) => !removed.has(entry.id));
      state.versions = state.versions.filter((entry) => !removed.has(entry.proposalId));
    });
  },
  async importOrder(input) {
    const example = exampleOrder(aiText(input), input.serviceId ?? null);
    return mutate((state) => {
      const order = insertOrder(state, example.input);
      if (!example.changes) return { order, proposal: null, version: null };
      const draft = makeDraft(state, order, example.changes);
      return { order: state.orders[0], ...draft };
    });
  },
  async getProposal(id) {
    const state = readState();
    const proposal = find(state.proposals, id, "Предложение не найдено.");
    return { proposal, versions: state.versions.filter((entry) => entry.proposalId === id).sort((a, b) => a.version - b.version) };
  },
  async createProposal(orderId, input) {
    const changes = aiText(input) || aiExamples.changes;
    return mutate((state) => {
      const order = find(state.orders, orderId, "Заказ не найден.");
      if (order.status !== "active") throw new MockError(409, "INVALID_STATE", "Сначала откройте заказ снова.");
      if (openProposal(state.proposals, orderId)) throw new MockError(409, "OPEN_PROPOSAL_EXISTS", "У заказа уже есть открытое предложение.");
      return makeDraft(state, order, changes);
    });
  },
  async reviseProposal(id, input) {
    const changes = aiText(input) || aiExamples.changes;
    return mutate((state) => {
      const { proposal, order, version } = findProposal(state, id, input.expectedVersionId);
      if (!isOpen(proposal.status)) {
        throw new MockError(409, "INVALID_STATE", "Это предложение уже закрыто.");
      }
      return makeDraft(state, order, changes, { proposal, version });
    });
  },
  async updateProposal(id, input) {
    return mutate((state) => {
      const { proposal, version, order } = findProposal(state, id, input.expectedVersionId);
      if (!isOpen(proposal.status)) throw new MockError(409, "INVALID_STATE", "Это предложение доступно только для просмотра.");
      const overwrite = proposal.status === "draft" && proposal.publishedVersionId !== version.id;
      return writeDraft(state, order, input.content, { proposal, version }, overwrite);
    });
  },
  async publishProposal(id, input) {
    return mutate((state) => {
      const { proposal, version, order } = findProposal(state, id, input.expectedVersionId);
      if (input.format === "pdf" || input.format === "link") {
        throw new MockError(503, "SERVICE_UNAVAILABLE", "Этот формат требует подключения сервера.");
      }
      if (proposal.status === "pending" && proposal.publishedVersionId === version.id) return { proposal, version };
      if (proposal.status !== "draft") throw new MockError(409, "INVALID_STATE", "К согласованию можно подготовить текущий черновик.");
      return saveProposal(state, order, {
        ...proposal, status: "pending", publishedVersionId: version.id, updatedAt: new Date().toISOString(),
      }, version);
    });
  },
  async approveProposal(id, input) {
    return mutate((state) => {
      const { proposal, version, order } = findProposal(state, id, input.expectedVersionId);
      if (proposal.status === "approved" && proposal.approvedVersionId === version.id) return { proposal, version };
      if (proposal.status !== "pending" && proposal.status !== "countered") {
        throw new MockError(409, "INVALID_STATE", "Сначала подготовьте предложение к согласованию.");
      }
      if (version.baseOrderRevision !== order.revision) {
        throw new MockError(409, "ORDER_CHANGED", "Договорённости заказа изменились. Обновите предложение перед согласованием.");
      }
      return saveProposal(state, { ...order, revision: order.revision + 1, deadline: version.deadline ?? order.deadline }, {
        ...proposal, status: "approved", approvedVersionId: version.id, updatedAt: new Date().toISOString(),
      }, version);
    });
  },
  async rejectProposal(id, input) {
    return mutate((state) => {
      const { proposal, version, order } = findProposal(state, id, input.expectedVersionId);
      if (!isOpen(proposal.status)) throw new MockError(409, "INVALID_STATE", "Это предложение уже закрыто.");
      return saveProposal(state, order, { ...proposal, status: "rejected", updatedAt: new Date().toISOString() }, version);
    });
  },
  async respondToDemoCounter(id, input) {
    return mutate((state) => {
      const { proposal, version, order } = findProposal(state, id, input.expectedVersionId);
      if (proposal.status !== "pending" || proposal.publishedVersionId !== version.id) {
        throw new MockError(409, "INVALID_STATE", "Ответ возможен для актуального предложения на согласовании.");
      }
      const items = input.content.items.map((item) => {
        const known = version.items.find((entry) => entry.id === item.id);
        const unchanged = known && known.title === item.title.trim() && known.description === item.description.trim();
        return { ...item, category: unchanged ? known.category : "unclear" as const, reason: unchanged ? known.reason : "" };
      });
      const content = proposalContent({ ...input.content, title: version.title, items }, version);
      const now = new Date().toISOString();
      const counter: ProposalVersion = {
        ...version, ...content, id: newId(), version: version.version + 1, author: "client", createdAt: now,
      };
      return saveProposal(state, order, { ...proposal, status: "countered", currentVersionId: counter.id, updatedAt: now }, counter, true);
    });
  },
};
