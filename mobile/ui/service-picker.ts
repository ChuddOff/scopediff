import type { ID, Service } from "../../shared/types";
import { api } from "../api/client";
import { resource } from "./async";
import { arrow, cardStyle, dialog, hint, secondaryButton } from "./components";
import { colors, space, type } from "./theme";

type ServiceChoice = { id: ID | null; name: string };

export function servicePicker(initial: ServiceChoice | null) {
  const selected = signal(initial);
  const services = resource(api.listServices);

  function choose(service: Service | null) {
    selected.value = service ? { id: service.id, name: service.name } : null;
    modal.hide();
  }

  const choices = services.view((items) => items.length
    ? items.map((service) => secondaryButton(service.name, `choose-service-${service.id}`, () => choose(service)))
    : [hint("В каталоге пока нет услуг.")]);

  const modal = dialog(
    UIText("Выберите услугу").style(type.card),
    secondaryButton("Без услуги", "choose-no-service", () => choose(null)),
    UIScrollable(choices).style({ maxHeight: 260, minHeight: 0, flexShrink: 1 }),
    secondaryButton("Отмена", "cancel-service-picker", () => modal.hide()),
  ).style({ maxHeight: "85%" });

  const control = UIButton(
    UIText(() => selected.value?.name ?? "Без услуги").style({ ...type.body, flex: 1, minWidth: 0, lineClamp: 2 }),
    arrow(),
  ).style({ ...cardStyle, minHeight: 48, padding: space.md, gap: space.md, $pressed: { backgroundColor: colors.ai } })
    .named("select-service").onClick(() => {
      modal.show();
      void services.load();
    });

  return { selected, control, modal };
}
