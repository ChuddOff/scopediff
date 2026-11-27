import type { ChangeItem, ProposalStatus, ProposalVersion } from "../../shared/types";
import { categoryLabels, formatDate, formatMoney, priceSummary, proposalStatus } from "../proposals/model";
import { card, hint, icon, wordmark } from "./components";
import { colors, radius, space, type } from "./theme";

function stamp(label: string, ink: string, background: string) {
  return UIText(label).style({ ...type.label, color: ink, backgroundColor: background,
    alignSelf: "flex-start", paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.control });
}

export function statusStamp(status: ProposalStatus) {
  if (status === "approved") return stamp(proposalStatus[status], colors.successInk, colors.successSurface);
  if (status === "countered") return stamp(proposalStatus[status], colors.warningInk, colors.warningSurface);
  if (status === "rejected") return stamp(proposalStatus[status], colors.danger, colors.dangerSurface);
  return stamp(proposalStatus[status], colors.accentInk, colors.ai);
}

function categoryStamp(category: ChangeItem["category"]) {
  const label = categoryLabels[category];
  if (category === "included") return stamp(label, colors.successInk, colors.successSurface);
  if (category === "unclear") return stamp(label, colors.warningInk, colors.warningSurface);
  return stamp(label, colors.accentInk, colors.ai);
}

function documentItem(item: ChangeItem, index: number) {
  const reasonOpen = signal(false);
  return UIColumn(
    UIText(`${index + 1}. ${item.title}`).style(type.card),
    item.description && item.description !== item.title ? hint(item.description) : null,
    UIRow(categoryStamp(item.category), UIText(item.price === null ? "Цена не определена" : formatMoney(item.price))
      .style({ ...type.label, color: item.price === null ? colors.textMuted : colors.text }))
      .style({ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: space.sm }),
    item.reason ? UIButton(
      icon(assetIcon("lucide:sparkles"), colors.accentInk, 14),
      UIText(() => reasonOpen.value ? "Скрыть пояснение" : "Пояснение AI").style({ ...type.label, color: colors.accentInk }),
    ).style({ alignSelf: "flex-start", minHeight: 44, gap: space.xs })
      .named(`reason-${index + 1}`).onClick(() => { reasonOpen.value = !reasonOpen.value; }) : null,
    item.reason ? UIText(item.reason).style({ ...type.small, padding: space.md, borderRadius: radius.control,
      color: colors.accentInk, backgroundColor: colors.ai, display: () => reasonOpen.value ? "flex" : "none" }) : null,
  ).style({ gap: space.sm });
}

function line() { return UIBox().style({ height: 1, backgroundColor: colors.border }); }

export function proposalDocument(version: ProposalVersion) {
  const totals = priceSummary(version.items);
  return card(
    UIRow(wordmark(19), UIText(formatDate(version.createdAt)).style({ ...type.small, color: colors.textMuted }))
      .style({ justifyContent: "space-between", alignItems: "center", gap: space.sm }),
    line(),
    UIText(version.title).style({ fontSize: 25, lineHeight: 31, fontWeight: 700, letterSpacing: -0.5 }),
    UIColumn(
      UIText("Перечень работ").style({ ...type.label, color: colors.textMuted }),
      version.items.flatMap((item, index) => index ? [line(), documentItem(item, index)] : [documentItem(item, index)]),
    ).style({ gap: space.md }),
    UIColumn(
      UIText(totals.total === null ? "Итоговая доплата не определена" : "Итоговая доплата").style(type.card),
      totals.total !== null ? UIText(formatMoney(totals.total)).style({ fontSize: 24, lineHeight: 30, fontWeight: 700, color: colors.accentInk }) : null,
      totals.total === null && totals.unknown < version.items.length ? hint(`Известная доплата · ${formatMoney(totals.known)}`) : null,
    ).style({ padding: space.md, borderRadius: radius.control, backgroundColor: colors.ai, gap: space.xs }).named("proposal-total"),
    version.deadline ? UIColumn(UIText("Новый срок").style(type.label), hint(formatDate(version.deadline))).style({ gap: space.xs }) : null,
    version.conditions ? UIColumn(UIText("Дополнительные условия").style(type.label), hint(version.conditions)).style({ gap: space.xs }) : null,
    version.comment ? UIColumn(UIText("Комментарий").style(type.label), hint(version.comment)).style({ gap: space.xs }) : null,
  ).style({ padding: space.xl, gap: space.lg, boxShadow: "0 3px 12px rgba(17,24,39,.06)" }).named("proposal-document");
}
