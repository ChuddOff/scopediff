import type { ID, Service } from "../../shared/types";
import { api } from "../api/client";
import { resource } from "../ui/async";
import { cardStyle, emptyState, hint, icon, iconTile, page, pageBody, pageTitle, primaryButton } from "../ui/components";
import { colors, space, type } from "../ui/theme";

function serviceCard(service: Service, onOpen: () => void) {
  return UIButton(
    UIText(service.name).style({ ...type.card, lineClamp: 2 }),
    service.description ? UIText(service.description).style({ ...type.body, color: colors.textMuted, lineClamp: 3 }) : null,
  ).style({
    ...cardStyle, flexDirection: "column", alignItems: "stretch", padding: space.lg,
    gap: space.xs, $pressed: { backgroundColor: colors.ai },
  }).named(`service-${service.id}`).onClick(onOpen);
}

function importCard(onCreate: () => void) {
  return UIButton(
    iconTile(assetIcon("lucide:sparkles")),
    UIColumn(
      UIText("Импорт услуг с AI").style({ ...type.card, color: colors.accentInk }),
      UIText("Продиктуйте описание или добавьте скриншоты").style({
        ...type.small,
        color: colors.accentInk,
      }),
    ).style({ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: space.xs }),
    icon(assetIcon("lucide:arrow-right"), colors.accentInk, 18),
  ).style({
    ...cardStyle,
    borderColor: colors.aiStrong,
    backgroundColor: colors.ai,
    padding: space.lg,
    gap: space.md,
    $pressed: { backgroundColor: colors.aiStrong },
  }).named("import-services").onClick(onCreate);
}

export function servicesScreen(onCreate: () => void, onOpen: (id: ID) => void, onBack?: () => void) {
  const services = resource(api.listServices);
  return services.bind(page("services", pageBody(
    UIColumn(
      pageTitle("Мои услуги"),
      hint("Добавьте услуги, которые вы предоставляете, чтобы AI учитывал их условия при анализе правок"),
    ).style({ gap: space.xs }),
    importCard(onCreate),
    services.view((items) => items.length
      ? items.map((service) => serviceCard(service, () => onOpen(service.id)))
      : [emptyState("Услуг пока нет", "Создайте услугу вручную или импортируйте её описание.")], space.md),
  ), { action: primaryButton("Создать услугу", "new-service", onCreate, assetIcon("lucide:plus")), onBack }));
}
