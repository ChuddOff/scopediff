import type { ID, Service } from "../../shared/types";
import { api } from "../api/client";
import { resource } from "../ui/async";
import { actionMenu, card, hint, menuAction, page, pageBody, primaryButton, recordHeader, recordTitle } from "../ui/components";
import { deleteDialog } from "../ui/delete-dialog";
import { type } from "../ui/theme";

export function serviceDetail(id: ID, edit: (service: Service) => void, createOrder: (service: Service) => void) {
  const details = resource(() => api.getService(id));
  const deletion = deleteDialog("Удалить услугу?", "Существующие заказы сохранят условия этой услуги.", () => api.deleteService(id), details.load);
  const actions = actionMenu("Действия с услугой", "close-service-menu",
    menuAction("Удалить услугу", "delete-service", assetIcon("lucide:trash-2"), () => {
      actions.hide();
      deletion.show();
    }, true),
  );

  const screen = page("service-detail", pageBody(details.view((service) => [
    recordHeader(recordTitle(service.name), "service", () => edit(service), () => actions.show()),
    card(UIText("Описание").style(type.card), hint(service.description || "Описание пока не добавлено.")),
  ])), {
    onBack: () => Router.pop(),
    actionVisible: () => details.state.value.status === "ready",
    action: primaryButton("Создать заказ", "order-from-service", () => {
      const data = details.state.value;
      if (data.status === "ready") createOrder(data.data);
    }, assetIcon("lucide:plus")),
  });
  return details.bind(screen.widgets(actions, deletion.modal));
}
