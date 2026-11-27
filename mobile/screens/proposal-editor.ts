import type { ChangeCategory, ChangeItem, Proposal, ProposalVersion } from "../../shared/types";
import { api, isConflict, isOutcomeUnknown } from "../api/client";
import { categoryLabels, formatMoney, parsePrice, priceSummary } from "../proposals/model";
import { errorNotice, mutation } from "../ui/async";
import { card, dialog, hint, page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { dateInput, field, textArea, textInput } from "../ui/fields";
import { colors, space, type } from "../ui/theme";

type ItemForm = {
  node: UIColumn;
  read: () => Omit<ChangeItem, "id"> & { id: ChangeItem["id"] | null };
};

export function proposalEditor(proposal: Proposal, version: ProposalVersion) {
  const save = mutation();
  const conflict = signal(false);
  const rows = signal<ItemForm[]>([]);
  const pickingCategory = signal<Signal<ChangeCategory> | null>(null);
  let rowNumber = 0;
  const title = textInput("proposal-title", "Название предложения", version.title, 160);
  const deadline = dateInput("proposal-deadline", version.deadline ?? "");
  const hasDeadline = signal(Boolean(deadline.value));
  deadline.onChange((value) => { hasDeadline.value = Boolean(value); });
  const conditions = textArea("proposal-conditions", "Согласованные ограничения и условия", version.conditions);

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
    const title = textInput(`work-title-${number}`, "Название работы", item?.title ?? "", 160);
    const description = textArea(`work-description-${number}`, "Что нужно выполнить", item?.description ?? "", 12000, 72);
    const price = textInput(`work-price-${number}`, "Не определена", item?.price == null ? "" : String(item.price), 16)
      .style({ type: "number" });
    const priceValue = signal(price.value);
    price.onChange((value) => { priceValue.value = value; });
    const category = signal<ChangeCategory>(item?.category ?? "unclear");
    const row: ItemForm = {
      node: card(
        field("Название работы", title),
        field("Описание работы", description),
        UIColumn(UIText("Категория").style(type.label), secondaryButton(() => categoryLabels[category.value], `work-category-${number}`, () => {
          pickingCategory.value = category;
          categories.show();
        })).style({ gap: space.sm }),
        field("Доплата, ₽ · необязательно", price),
        secondaryButton("Удалить работу", `remove-work-${number}`, () => {
          rows.value = rows.value.filter((entry) => entry !== row);
        }, true),
      ).style({ gap: space.md }),
      read: () => ({
        id: item?.id ?? null,
        title: title.value, description: description.value, category: category.value, price: parsePrice(priceValue.value),
        reason: title.value.trim() === item?.title && description.value.trim() === item.description && category.value === item.category
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
    if (conflict.value) return;
    const content = {
      title: title.value, items: rows.value.map((row) => row.read()), deadline: deadline.value || null,
      conditions: conditions.value, comment: version.comment,
    };
    void save.run(() => api.updateProposal(proposal.id, { expectedVersionId: version.id, content }),
      () => Router.pop(), (error) => { conflict.value = isConflict(error) || isOutcomeUnknown(error); });
  }

  return page("proposal-editor", pageBody(
    pageTitle("Редактировать предложение"),
    proposal.status !== "draft" ? hint("После сохранения появится новый черновик. Эта версия останется в истории.") : null,
    field("Название предложения", title),
    UIColumn(() => rows.value.map((row) => row.node)).style({ gap: space.md }),
    secondaryButton("Добавить работу", "add-work", () => { rows.value = [...rows.value, itemForm()]; }),
    UIText(sumLabel).style({ ...type.card, padding: space.md, backgroundColor: colors.ai, color: colors.accentInk, borderRadius: 12 })
      .named("editor-total"),
    field("Новый срок · необязательно", deadline),
    secondaryButton("Убрать срок", "clear-proposal-deadline", () => {
      deadline.value = "";
      hasDeadline.value = false;
    }).style({ display: () => hasDeadline.value ? "flex" : "none" }),
    field("Дополнительные условия", conditions),
  ), {
    feedback: errorNotice(save.error),
    action: primaryButton(() => conflict.value ? "Открыть актуальную версию" : save.pending.value ? "Сохраняем…" : "Сохранить", "save-proposal", () => {
      if (conflict.value) Router.pop();
      else submit();
    }),
    onBack: () => { if (!save.pending.value) Router.pop(); },
  }).widgets(categories);
}
