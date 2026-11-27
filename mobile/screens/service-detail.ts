import type { ID, Service } from "../../shared/types";
import { api } from "../api/client";
import { resource } from "../ui/async";
import { card, hint, page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { deleteDialog } from "../ui/delete-dialog";
import { type } from "../ui/theme";

export function serviceDetail(id: ID, edit: (service: Service) => void, createOrder: (service: Service) => void) {
  const details = resource(() => api.getService(id));
  const deletion = deleteDialog("Удалить услугу?", "Существующие заказы сохранят условия этой услуги.", () => api.deleteService(id));

  const screen = page("service-detail", pageBody(details.view((service) => [
    pageTitle(service.name),
    card(UIText("Описание").style(type.card), hint(service.description || "Описание пока не добавлено.")),
    secondaryButton("Редактировать услугу", "edit-service", () => edit(service)),
    secondaryButton("Удалить услугу", "delete-service", () => deletion.show(), true),
  ])), {
    onBack: () => Router.pop(),
    actionVisible: () => details.state.value.status === "ready",
    action: primaryButton("Создать заказ", "order-from-service", () => {
      const data = details.state.value;
      if (data.status === "ready") createOrder(data.data);
    }, assetIcon("lucide:plus")),
  });
  return details.bind(screen.widgets(deletion.modal));
}
