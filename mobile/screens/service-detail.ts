import type { ID, Service } from "../../shared/types";
import { api } from "../api/client";
import { resource } from "../ui/async";
import { card, dialog, hint, page, pageBody, primaryButton, recordHeader, recordTitle, secondaryButton } from "../ui/components";
import { deleteDialog } from "../ui/delete-dialog";
import { type } from "../ui/theme";

export function serviceDetail(id: ID, edit: (service: Service) => void, createOrder: (service: Service) => void) {
  const details = resource(() => api.getService(id));
  const deletion = deleteDialog("Удалить услугу?", "Существующие заказы сохранят условия этой услуги.", () => api.deleteService(id), details.load);
  const actions = dialog(
    UIText("Действия с услугой").style(type.card),
    secondaryButton("Удалить услугу", "delete-service", () => {
      actions.hide();
      deletion.show();
    }, true),
    secondaryButton("Закрыть", "close-service-menu", () => actions.hide()),
  ).onDismiss(() => actions.hide());

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
