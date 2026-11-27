import type { ID, Order, Proposal, Service } from "../shared/types";
import { api } from "./api/client";
import { isOpen } from "./proposals/model";
import { aiInputScreen, type AiMode } from "./screens/ai-input";
import { changeMethods, creationMethods } from "./screens/creation-methods";
import { orderDetail } from "./screens/order-detail";
import { orderForm } from "./screens/order-form";
import { ordersScreen } from "./screens/orders";
import { proposalScreen } from "./screens/proposal";
import { serviceDetail } from "./screens/service-detail";
import { serviceForm } from "./screens/service-form";
import { servicesScreen } from "./screens/services";

function servicePage(id: ID) {
  return serviceDetail(id, (service) => Router.push(serviceForm(service, () => Router.pop())), newOrder);
}

function orderPage(id: ID) {
  return orderDetail(id, (order) => Router.push(orderForm(order, null, () => Router.pop())),
    (order) => openChanges(order), () => Router.push(proposalPage(id)));
}

function proposalPage(orderId: ID, historical?: { proposalId: ID; versionId: ID }): UIScreen {
  return proposalScreen(orderId, historical, (order, proposal, mode) => openChanges(order, proposal, true, mode),
    (proposalId, versionId) => Router.push(proposalPage(orderId, { proposalId, versionId })));
}

export function openService(id: ID) { Router.push(servicePage(id)); }
export function openOrder(id: ID) { Router.push(orderPage(id)); }

function reviewServices() { Router.push(servicesScreen(newService, openService, () => Router.pop())); }
function reviewOrders() { Router.push(ordersScreen(newOrder, openOrder, () => Router.pop())); }

export function newService() {
  Router.push(creationMethods("service", (method) => {
    if (method === "manual") {
      Router.replace(serviceForm(null, (service) => Router.replace(servicePage(service.id)), reviewServices));
      return;
    }
    Router.replace(aiInputScreen({
      entity: "service", mode: method, title: method === "voice" ? "Услуги голосом" : "Услуги из скриншотов",
      button: "Импортировать услуги", submit: api.importServices,
      onSaved: () => Router.pop(),
      onReview: reviewServices,
    }));
  }));
}

export function newOrder(service?: Service) {
  Router.push(creationMethods("order", (method) => {
    if (method === "manual") {
      Router.replace(orderForm(null, service ?? null, (order) => Router.replace(orderPage(order.id)), reviewOrders));
      return;
    }
    Router.replace(aiInputScreen({
      entity: "order", mode: method, preset: service,
      title: method === "voice" ? "Заказ голосом" : "Заказ из скриншотов", button: "Импортировать заказ",
      submit: (input, serviceId) => api.importOrder({ ...input, serviceId }),
      onSaved: ({ order }) => Router.replace(orderPage(order.id)),
      onReview: reviewOrders,
    }));
  }, service));
}

function openChanges(order: Order, proposal?: Proposal, returnToWorkspace = false, inputMode?: AiMode) {
  const title = proposal ? "Изменить правки" : returnToWorkspace ? "Дополнить правки" : "Создать правки";
  let target = proposal;
  const input = (mode: AiMode) => aiInputScreen({
    entity: "changes", mode, title, button: "Обработать пожелания",
    context: `Заказ: ${order.title}\n${order.agreements}`.slice(0, 12000),
    submit: (input) => target
      ? api.reviseProposal(target.id, { ...input, expectedVersionId: target.currentVersionId })
      : api.createProposal(order.id, input),
    onSaved: () => {
      if (returnToWorkspace) Router.pop();
      else Router.replace(proposalPage(order.id));
    },
    onReview: async () => {
      const { proposals } = await api.getOrder(order.id);
      target = proposals.find((item) => isOpen(item.status)) ?? proposal;
      Router.push(orderPage(order.id));
    },
  });
  if (inputMode) Router.push(input(inputMode));
  else Router.push(changeMethods(title, (mode) => Router.replace(input(mode))));
}
