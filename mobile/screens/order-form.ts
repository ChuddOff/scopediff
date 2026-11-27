import type { Order, OrderInput, Service } from "../../shared/types";
import { api, isConflict, isOutcomeUnknown, type OrderPatch } from "../api/client";
import { errorNotice, mutation } from "../ui/async";
import { page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { dateInput, field, textArea, textInput } from "../ui/fields";
import { servicePicker } from "../ui/service-picker";
import { space, type } from "../ui/theme";

export function orderForm(order: Order | null, preset: Service | null, onSaved: (value: Order) => void, onReview = () => Router.pop()) {
  const save = mutation();
  const needsReview = signal(false);
  const title = textInput("order-title", "Например, лендинг для студии", order?.title ?? "", 160);
  const agreements = textArea("order-agreements", "Что согласовали с заказчиком", order?.agreements ?? "");
  const completed = textArea("order-completed-work", "Что уже сделано", order?.completedWork ?? "");
  const deadline = dateInput("order-deadline", order?.deadline ?? "");
  const hasDeadline = signal(Boolean(deadline.value));
  deadline.onChange((value) => { hasDeadline.value = Boolean(value); });

  const initialService = order?.serviceSnapshot
    ? { id: order.serviceId, name: order.serviceSnapshot.name }
    : preset;
  const picker = servicePicker(initialService);

  function submit() {
    const input: OrderInput = {
      title: title.value, agreements: agreements.value, completedWork: completed.value,
      deadline: deadline.value || null, serviceId: picker.selected.value?.id ?? null,
    };
    const patch: OrderPatch = { ...input };
    const removesArchivedService = order?.serviceId === null && order.serviceSnapshot && !picker.selected.value;
    if (order?.serviceId === input.serviceId && !removesArchivedService) delete patch.serviceId;
    void save.run(() => order ? api.updateOrder(order.id, patch) : api.createOrder(input), onSaved, (error) => {
      needsReview.value = isConflict(error) || isOutcomeUnknown(error);
    });
  }

  return page("order-form", pageBody(
    pageTitle(order ? "Редактировать заказ" : "Новый заказ"),
    field("Название", title),
    UIColumn(UIText("Услуга · необязательно").style(type.label), picker.control).style({ gap: space.sm }),
    field("Договорённости", agreements),
    field("Выполненные работы", completed),
    field("Срок · необязательно", deadline),
    secondaryButton("Убрать срок", "clear-deadline", () => {
      deadline.value = "";
      hasDeadline.value = false;
    }).style({ display: () => hasDeadline.value ? "flex" : "none" }),
  ), {
    feedback: errorNotice(save.error),
    action: primaryButton(() => save.pending.value ? "Сохраняем…" : needsReview.value ? "Проверить данные" : "Сохранить заказ", "save-order", () => {
      if (needsReview.value) {
        needsReview.value = false;
        onReview();
      } else submit();
    }),
    onBack: () => { if (!save.pending.value) Router.pop(); },
  }).widgets(picker.modal);
}
