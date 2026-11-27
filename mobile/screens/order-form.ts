import type { Order, OrderInput, Service } from "../../shared/types";
import { api, isConflict, isOutcomeUnknown, type OrderPatch } from "../api/client";
import { errorNotice, mutation } from "../ui/async";
import { aiNote, page, pageBody, pageTitle, primaryButton } from "../ui/components";
import { dictationField } from "../ui/dictation-field";
import { dateField, field, fieldLabel, textInput } from "../ui/fields";
import { servicePicker } from "../ui/service-picker";
import { space } from "../ui/theme";

export function orderForm(order: Order | null, preset: Service | null, onSaved: (value: Order) => void, onReview = () => Router.pop()) {
  const save = mutation();
  const needsReview = signal(false);
  const title = textInput("order-title", "Например, лендинг для студии", order?.title ?? "", 160);
  const deadline = dateField("Срок", "order-deadline", "clear-deadline", order?.deadline ?? null);

  const initialService = order?.serviceSnapshot
    ? { ...order.serviceSnapshot, id: order.serviceId }
    : preset;
  const picker = servicePicker(initialService);
  const description = dictationField("order-agreements", "Подробное описание",
    "Опишите задачу, требования и условия", order?.agreements ?? "", {
      kind: "order", title: () => title.value,
      context: () => {
        const service = picker.selected.value;
        return [
          service ? `Услуга: ${service.name}. ${service.description}` : "",
          order?.completedWork ? `Выполненная работа только для контекста, не часть исходного задания: ${order.completedWork}` : "",
        ].filter(Boolean).join("\n");
      },
    });

  function submit() {
    const input: OrderInput = {
      title: title.value, agreements: description.input.value, completedWork: "",
      deadline: deadline.value(), serviceId: picker.selected.value?.id ?? null,
    };
    const patch: OrderPatch = { title: input.title, agreements: input.agreements, deadline: input.deadline, serviceId: input.serviceId };
    const removesArchivedService = order?.serviceId === null && order.serviceSnapshot && !picker.selected.value;
    if (order?.serviceId === input.serviceId && !removesArchivedService) delete patch.serviceId;
    void save.run(() => order ? api.updateOrder(order.id, patch) : api.createOrder(input), onSaved, (error) => {
      needsReview.value = isConflict(error) || isOutcomeUnknown(error);
    });
  }

  return page("order-form", pageBody(
    pageTitle(order ? "Редактировать заказ" : "Новый заказ"),
    field("Название", title, true),
    UIColumn(fieldLabel("Услуга"), picker.control).style({ gap: space.sm }),
    description.node,
    aiNote("Помогите AI понять задачу", "Опишите задачу, требования и условия работы. Это поможет AI точнее анализировать правки заказчика."),
    deadline.node,
  ), {
    feedback: errorNotice(save.error),
    action: primaryButton(() => save.pending.value ? "Сохраняем…" : needsReview.value ? "Проверить данные" : "Сохранить заказ", "save-order", () => {
      if (description.busy()) return;
      if (needsReview.value) {
        needsReview.value = false;
        onReview();
      } else submit();
    }),
    onBack: () => { if (!save.pending.value) Router.pop(); },
  }).widgets(picker.modal).onClose(description.cancel);
}
