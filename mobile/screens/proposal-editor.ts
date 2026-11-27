import type { ChangeCategory, ChangeItem, Order, Proposal, ProposalVersion } from "../../shared/types";
import { api, isConflict, isOutcomeUnknown } from "../api/client";
import { categoryLabels, formatMoney, parsePrice, priceSummary } from "../proposals/model";
import { errorNotice, mutation } from "../ui/async";
import { card, dialog, hint, icon, page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { dictationField } from "../ui/dictation-field";
import { dateField, field, textInput } from "../ui/fields";
import { colors, space, type } from "../ui/theme";

type ItemForm = {
  key: number;
  node: UIColumn;
  read: () => Omit<ChangeItem, "id"> & { id: ChangeItem["id"] | null };
  busy: () => boolean;
  cancel: () => void;
};

export function proposalEditor(order: Order, proposal: Proposal, version: ProposalVersion) {
  const save = mutation();
  const conflict = signal(false);
  const rows = signal<ItemForm[]>([]);
  const pickingCategory = signal<Signal<ChangeCategory> | null>(null);
  let rowNumber = 0;
  const title = textInput("proposal-title", "Название документа", version.title, 160);
  const deadline = dateField("Новый срок", "proposal-deadline", "clear-proposal-deadline", version.deadline);
  const context = () => [`Заказ: ${order.title}`, order.agreements, `Документ: ${title.value}`].join("\n");
  const conditions = dictationField("proposal-conditions", "Дополнительные условия", "Ограничения и условия", version.conditions, {
    kind: "conditions", title: () => title.value,
    context: () => [context(), ...rows.value.map((row) => row.read().title)].join("\n").slice(0, 12000),
  });

  const categories = dialog(
    UIText("Категория работы").style(type.card),
    ...(Object.keys(categoryLabels) as ChangeCategory[]).map((category) => secondaryButton(
      categoryLabels[category], `category-${category}`, () => {
        const selected = pickingCategory.value;
        if (selected) selected.value = category;
        categories.hide();
      },
    )),
    secondaryButton("Отмена", "close-categories", () => categories.hide()),
  );

  function itemForm(item?: ChangeItem): ItemForm {
    const number = ++rowNumber;
    const itemTitle = textInput(`work-title-${number}`, "Название работы", item?.title ?? "", 160);
    const price = textInput(`work-price-${number}`, "Не определена", item?.price == null ? "" : String(item.price), 16)
      .style({ type: "number" });
    const priceValue = signal(price.value);
    price.onChange((value) => { priceValue.value = value; });
    const category = signal<ChangeCategory>(item?.category ?? "unclear");
    const description = dictationField(`work-description-${number}`, "Описание работы",
      "Что нужно выполнить", item?.description ?? "", {
        kind: "change_item", title: () => itemTitle.value,
        context: () => [`Категория: ${categoryLabels[category.value]}`, context()].join("\n").slice(0, 12000),
        minHeight: 72,
      });
    const expanded = signal<boolean | null>(item ? null : true);
    const isExpanded = () => expanded.value ?? rows.value.length <= 3;
    const caption = signal(itemTitle.value);
    itemTitle.onChange((value) => { caption.value = value; });
    const row: ItemForm = {
      key: number,
      node: card(
        UIButton(
          UIText(() => {
            const index = rows.value.findIndex((entry) => entry.key === number) + 1 || number;
            return caption.value.trim() ? `${index}. ${caption.value.trim()}` : `Пункт ${index}`;
          }).style({ ...type.card, flex: 1, minWidth: 0, lineClamp: 2 }),
          UIColumn(() => [icon(isExpanded() ? assetIcon("lucide:chevron-up") : assetIcon("lucide:chevron-down"), colors.textMuted, 18)]),
        ).style({ minHeight: 40, gap: space.sm }).named(`toggle-work-${number}`).onClick(() => { expanded.value = !isExpanded(); }),
        UIColumn(
          field("Название работы", itemTitle, true),
          description.node,
          UIColumn(UIText("Категория").style(type.label), secondaryButton(() => categoryLabels[category.value], `work-category-${number}`, () => {
            pickingCategory.value = category;
            categories.show();
          })).style({ gap: space.sm }),
          field("Доплата, ₽", price),
          secondaryButton("Удалить работу", `remove-work-${number}`, () => {
            description.cancel();
            rows.value = rows.value.filter((entry) => entry.key !== number);
          }, true),
        ).style({ gap: space.md, display: () => isExpanded() ? "flex" : "none" }),
      ).style({ gap: space.md }),
      busy: description.busy,
      cancel: description.cancel,
      read: () => ({
        id: item?.id ?? null,
        title: itemTitle.value, description: description.input.value, category: category.value, price: parsePrice(priceValue.value),
        reason: itemTitle.value.trim() === item?.title && description.input.value.trim() === item.description && category.value === item.category
          ? item.reason : "",
      }),
    };
    return row;
  }

  rows.value = version.items.map(itemForm);

  function sumLabel() {
    if (!rows.value.length) return "Добавьте работы, чтобы рассчитать доплату.";
    const items = rows.value.map((row) => row.read());
    const totals = priceSummary(items);
    if (!Number.isSafeInteger(totals.known)) return "Проверьте стоимость работ.";
    if (totals.total !== null) return `Итоговая доплата · ${formatMoney(totals.total)}`;
    return totals.unknown < items.length ? `Известная доплата · ${formatMoney(totals.known)}` : "Итоговая доплата не определена";
  }

  function submit() {
    if (conflict.value || conditions.busy() || rows.value.some((row) => row.busy())) return;
    const content = {
      title: title.value, items: rows.value.map((row) => row.read()), deadline: deadline.value(),
      conditions: conditions.input.value, comment: version.comment,
    };
    void save.run(() => api.updateProposal(proposal.id, { expectedVersionId: version.id, content }),
      () => Router.pop(), (error) => { conflict.value = isConflict(error) || isOutcomeUnknown(error); });
  }

  return page("proposal-editor", pageBody(
    pageTitle("Редактировать правки"),
    proposal.status !== "draft" ? hint("После сохранения появится новый черновик. Эта версия останется в истории.") : null,
    field("Название документа", title, true),
    UIColumn(() => rows.value.map((row) => row.node)).style({ gap: space.md }),
    secondaryButton("Добавить работу", "add-work", () => { rows.value = [...rows.value, itemForm()]; }),
    UIText(sumLabel).style({ ...type.card, padding: space.md, backgroundColor: colors.ai, color: colors.accentInk, borderRadius: 12 })
      .named("editor-total"),
    deadline.node,
    conditions.node,
  ), {
    feedback: errorNotice(save.error),
    action: primaryButton(() => conflict.value ? "Открыть актуальную версию" : save.pending.value ? "Сохраняем…" : "Сохранить", "save-proposal", () => {
      if (conflict.value) Router.pop();
      else submit();
    }),
    onBack: () => { if (!save.pending.value) Router.pop(); },
  }).widgets(categories).onClose(() => {
    conditions.cancel();
    for (const row of rows.value) row.cancel();
  });
}
