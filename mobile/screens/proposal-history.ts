import type { ID, ProposalVersion } from "../../shared/types";
import { api } from "../api/client";
import { compareVersions } from "../proposals/diff";
import { categoryLabels, formatDate, formatMoney, priceSummary, proposalStatus, recentRounds } from "../proposals/model";
import { resource } from "../ui/async";
import { arrow, card, cardStyle, hint, page, pageBody, pageTitle } from "../ui/components";
import { colors, space, type } from "../ui/theme";

export function versionHistory(orderId: ID, openVersion: (proposalId: ID, versionId: ID) => void) {
  const history = resource(async () => {
    const { proposals } = await api.getOrder(orderId);
    return Promise.all(recentRounds(proposals).map((proposal) => api.getProposal(proposal.id)));
  });
  return history.bind(page("proposal-history", pageBody(
    pageTitle("История версий"),
    history.view((rounds) => rounds.map(({ proposal, versions }, index) => {
      const round = rounds.length - index;
      return UIColumn(
        rounds.length > 1 ? UIText(`Раунд ${round} · ${proposalStatus[proposal.status]}`).style(type.label) : null,
        [...versions].reverse().map((version) => UIButton(
          UIColumn(
            UIText(`Версия ${version.version}${version.id === proposal.currentVersionId ? " · последняя в раунде" : ""}`).style(type.card),
            hint(`${version.author === "client" ? "Заказчик" : "Исполнитель"} · ${formatDate(version.createdAt)}`),
          ).style({ flex: 1, minWidth: 0, gap: space.xs }),
          arrow(),
        ).style({ ...cardStyle, padding: space.lg, gap: space.md, $pressed: { backgroundColor: colors.ai } })
          .named(index === 0 ? `history-version-${version.version}` : `history-round-${round}-version-${version.version}`)
          .onClick(() => openVersion(proposal.id, version.id))),
      ).style({ gap: space.sm });
    }), space.md),
  ), { onBack: () => Router.pop() }));
}

function totalLabel(version: ProposalVersion) {
  const total = priceSummary(version.items);
  if (total.total !== null) return formatMoney(total.total);
  return total.unknown === version.items.length ? "Не определена" : `Известно ${formatMoney(total.known)}, итог не определён`;
}

function beforeAfter(title: string, before: string, after: string) {
  return UIColumn(UIText(title).style(type.label), hint(`Было · ${before || "Не указано"}`), hint(`Стало · ${after || "Не указано"}`))
    .style({ gap: space.xs });
}

export function comparisonScreen(before: ProposalVersion, after: ProposalVersion) {
  const diff = compareVersions(before, after);
  const oldTotal = totalLabel(before);
  const newTotal = totalLabel(after);
  const oldDate = before.deadline ? formatDate(before.deadline) : "Без изменения срока";
  const newDate = after.deadline ? formatDate(after.deadline) : "Без изменения срока";
  const changedConditions = diff.conditions || diff.deadline || diff.comment || diff.title || oldTotal !== newTotal;

  return page("proposal-diff", pageBody(
    UIColumn(pageTitle("Сравнение версий"), hint(`Версия ${before.version} → версия ${after.version}`)).style({ gap: space.xs }),
    diff.added.length ? card(UIText("Добавленные работы").style(type.card), ...diff.added.map((item) => hint(item.title))) : null,
    diff.removed.length ? card(UIText("Удалённые работы").style(type.card), ...diff.removed.map((item) => hint(item.title))) : null,
    ...diff.changed.map(({ before, after }) => card(
      UIText(after.title).style(type.card),
      before.title !== after.title ? beforeAfter("Название", before.title, after.title) : null,
      before.description !== after.description ? beforeAfter("Описание", before.description, after.description) : null,
      before.category !== after.category ? beforeAfter("Категория", categoryLabels[before.category], categoryLabels[after.category]) : null,
      before.price !== after.price ? beforeAfter("Доплата", before.price === null ? "Не определена" : formatMoney(before.price),
        after.price === null ? "Не определена" : formatMoney(after.price)) : null,
    ).style({ gap: space.md })),
    changedConditions ? card(
      UIText("Условия предложения").style(type.card),
      diff.title ? beforeAfter("Название", before.title, after.title) : null,
      diff.conditions ? beforeAfter("Дополнительные условия", before.conditions, after.conditions) : null,
      diff.deadline ? beforeAfter("Срок", oldDate, newDate) : null,
      oldTotal !== newTotal ? beforeAfter("Общая доплата", oldTotal, newTotal) : null,
      diff.comment ? beforeAfter("Комментарий", before.comment ?? "", after.comment ?? "") : null,
    ).style({ gap: space.md }) : null,
    !diff.added.length && !diff.removed.length && !diff.changed.length && !changedConditions
      ? card(UIText("Содержание совпадает").style(type.card)) : null,
  ), { onBack: () => Router.pop() });
}
