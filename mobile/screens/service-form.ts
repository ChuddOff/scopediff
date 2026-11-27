import type { Service } from "../../shared/types";
import { api, isConflict, isOutcomeUnknown } from "../api/client";
import { errorNotice, mutation } from "../ui/async";
import { aiNote, page, pageBody, pageTitle, primaryButton } from "../ui/components";
import { dictationField } from "../ui/dictation-field";
import { field, textInput } from "../ui/fields";

export function serviceForm(service: Service | null, onSaved: (value: Service) => void, onReview = () => Router.pop()) {
  const save = mutation();
  const needsReview = signal(false);
  const name = textInput("service-name", "Например, дизайн лендинга", service?.name ?? "", 120);
  const description = dictationField("service-description", "Подробное описание",
    "Состав работ, ограничения и условия", service?.description ?? "", {
      kind: "service", title: () => name.value, context: () => "Услуга фрилансера: состав работ, ограничения и условия.",
    });

  return page("service-form", pageBody(
    pageTitle(service ? "Редактировать услугу" : "Новая услуга"),
    field("Название", name, true),
    description.node,
    aiNote(
      "Помогите AI понять вашу работу",
      "Подробно опишите состав услуги, ограничения, количество бесплатных правок и дополнительные условия. Это поможет AI точнее анализировать пожелания заказчиков.",
    ),
  ), {
    feedback: errorNotice(save.error),
    onBack: () => { if (!save.pending.value) Router.pop(); },
    action: primaryButton(() => save.pending.value ? "Сохраняем…" : needsReview.value ? "Проверить данные" : "Сохранить услугу", "save-service", () => {
      if (description.busy()) return;
      if (needsReview.value) {
        needsReview.value = false;
        onReview();
        return;
      }
      const input = { name: name.value, description: description.input.value };
      void save.run(() => service ? api.updateService(service.id, input) : api.createService(input), onSaved, (error) => {
        needsReview.value = isConflict(error) || isOutcomeUnknown(error);
      });
    }),
  }).onClose(description.cancel);
}
