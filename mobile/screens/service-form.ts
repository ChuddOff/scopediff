import type { Service } from "../../shared/types";
import { api } from "../api/client";
import { errorNotice, mutation } from "../ui/async";
import { aiNote, page, pageBody, pageTitle, primaryButton } from "../ui/components";
import { field, textArea, textInput } from "../ui/fields";

export function serviceForm(service: Service | null, onSaved: (value: Service) => void) {
  const save = mutation();
  const name = textInput("service-name", "Например, дизайн лендинга", service?.name ?? "", 120);
  const description = textArea("service-description", "Состав работ, ограничения и условия", service?.description ?? "");

  return page("service-form", pageBody(
    pageTitle(service ? "Редактировать услугу" : "Новая услуга"),
    field("Название", name),
    field("Подробное описание", description),
    aiNote(
      "Помогите AI понять вашу работу",
      "Опишите услугу максимально подробно: что входит в работу, какие есть ограничения, сколько бесплатных правок предусмотрено и какие условия вы обычно согласовываете с заказчиками. Чем подробнее описание, тем точнее AI будет анализировать новые пожелания",
    ),
  ), {
    feedback: errorNotice(save.error),
    onBack: () => { if (!save.pending.value) Router.pop(); },
    action: primaryButton(() => save.pending.value ? "Сохраняем…" : "Сохранить услугу", "save-service", () => {
      const input = { name: name.value, description: description.value };
      void save.run(() => service ? api.updateService(service.id, input) : api.createService(input), onSaved);
    }),
  });
}
