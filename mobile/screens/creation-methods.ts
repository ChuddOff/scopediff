import type { Service } from "../../shared/types";
import { arrow, cardStyle, hint, iconTile, page, pageBody, pageTitle } from "../ui/components";
import { colors, space, type } from "../ui/theme";

export type Entity = "order" | "service";
export type Method = "voice" | "screenshots" | "manual";
type InputMethod = Method | "text";
type MethodOption<T> = { id: T; label: string; icon: SvgSource };

const voice = { id: "voice", label: "Голосом", icon: assetIcon("lucide:mic") } as const;
const screenshots = { id: "screenshots", label: "Скриншотами", icon: assetIcon("lucide:images") } as const;
const methods: MethodOption<Method>[] = [
  voice, screenshots,
  { id: "manual", label: "Вручную", icon: assetIcon("lucide:pencil-line") },
];

const copy = {
  order: {
    title: "Новый заказ",
    voice: "Расскажите, о чём договорились с заказчиком.",
    screenshots: "Используйте переписку или материалы заказа.",
    manual: "Укажите название и основные договорённости.",
  },
  service: {
    title: "Новая услуга",
    voice: "Расскажите, что входит в ваши услуги.",
    screenshots: "Используйте скриншоты с описаниями услуг.",
    manual: "Укажите название и состав работ.",
  },
};

function chooseInput<T extends InputMethod>(name: string, title: string, options: MethodOption<T>[], descriptions: Record<T, string>,
  onChoose: (method: T) => void, subtitle: string, context?: string) {
  const choices = options.map((method) => UIButton(
    UIRow(iconTile(method.icon), arrow()).style({ justifyContent: "space-between", alignItems: "flex-start" }),
    UIColumn(
      UIText(method.label).style({ ...type.card, fontSize: 20, lineHeight: 26 }),
      hint(descriptions[method.id]),
    ).style({ gap: space.xs }),
  ).style({
    ...cardStyle, flexDirection: "column", alignItems: "stretch", padding: space.lg, gap: space.md,
    $pressed: { backgroundColor: colors.ai },
  })
    .named(`method-${method.id}`).onClick(() => onChoose(method.id)));

  return page(name, pageBody(
    UIColumn(pageTitle(title), context ? hint(context) : null, hint(subtitle))
      .style({ gap: space.xs }),
    UIColumn(choices).style({ gap: space.md }),
  ), { onBack: () => Router.pop() });
}

export function creationMethods(entity: Entity, onChoose: (method: Method) => void, service?: Service) {
  const wording = copy[entity];
  return chooseInput(`create-${entity}`, wording.title, methods, wording, onChoose, "Выберите способ создания", service?.name);
}

export function changeMethods(title: string, onChoose: (method: "voice" | "screenshots" | "text") => void) {
  return chooseInput("change-methods", title, [voice, screenshots, { id: "text", label: "Текстом", icon: assetIcon("lucide:file-text") }], {
    voice: "Продиктуйте новые пожелания.",
    screenshots: "Добавьте скриншоты переписки с заказчиком.",
    text: "Вставьте сообщение или опишите правки.",
  }, onChoose, "Выберите способ ввода");
}
