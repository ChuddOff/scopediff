import type { ID, Proposal, Service } from "../shared/types";
import { api } from "./api/client";
import { isOpen } from "./proposals/model";
import { aiInputScreen } from "./screens/ai-input";
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
    (order, proposal) => openChanges(order.id, proposal), (proposalId) => Router.push(proposalPage(proposalId)));
}

function proposalPage(id: ID, versionId?: ID): UIScreen {
  return proposalScreen(id, versionId, (proposal) => openChanges(proposal.orderId, proposal, true),
    (historyId) => Router.push(proposalPage(id, historyId)));
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

function openChanges(orderId: ID, proposal?: Proposal, returnToProposal = false) {
  const title = proposal ? "Добавить замечания" : "Добавить правки";
  let target = proposal;
  Router.push(changeMethods(title, (mode) => Router.replace(aiInputScreen({
    entity: "changes", mode, title, button: "Обработать пожелания",
    submit: (input) => target
      ? api.reviseProposal(target.id, { ...input, expectedVersionId: target.currentVersionId })
      : api.createProposal(orderId, input),
    onSaved: (result) => {
      if (returnToProposal && result.proposal.id === proposal?.id) Router.pop();
      else Router.replace(proposalPage(result.proposal.id));
    },
    onReview: async () => {
      const { proposals } = await api.getOrder(orderId);
      target = proposals.find((item) => isOpen(item.status)) ?? proposal;
      Router.push(orderPage(orderId));
    },
  }))));
}
