import type { ID, Order, Proposal, ProposalVersion } from "../../shared/types";
import { api } from "../api/client";
import { formatDate, isOpen, proposalStatus } from "../proposals/model";
import { errorNotice, mutation, resource } from "../ui/async";
import { arrow, card, cardStyle, dialog, emptyState, hint, icon, page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { deleteDialog } from "../ui/delete-dialog";
import { colors, radius, space, type } from "../ui/theme";
import { orderStatus } from "./orders";

function about(order: Order) {
  return card(
    UIText("О заказе").style(type.card),
    UIColumn(UIText("Договорённости").style(type.label), hint(order.agreements || "Пока не указаны"))
      .style({ gap: space.xs }),
    UIColumn(UIText("Выполненные работы").style(type.label), hint(order.completedWork || "Пока не указаны"))
      .style({ gap: space.xs }),
    order.deadline ? UIRow(
      icon(assetIcon("lucide:calendar-days"), colors.accentInk, 16),
      UIText(`Срок · ${formatDate(order.deadline)}`).style(type.label),
    ).style({ gap: space.sm, alignItems: "center" }) : null,
  ).style({ gap: space.md });
}

function approvedChanges(versions: ProposalVersion[]) {
  if (!versions.length) return null;
  return UIColumn(
    UIText("Согласованные изменения").style({ ...type.card, fontSize: 20, lineHeight: 26 }),
    versions.map((version) => card(
      UIText(version.title).style(type.card),
      ...version.items.map((item) => UIColumn(
        UIText(item.title).style(type.label),
        item.description && item.description !== item.title ? hint(item.description) : null,
      ).style({ gap: space.xs })),
      version.deadline ? hint(`Согласованный срок · ${formatDate(version.deadline)}`) : null,
      version.conditions ? hint(version.conditions) : null,
    ).style({ gap: space.sm }).named(`approved-changes-${version.id}`)),
  ).style({ gap: space.md });
}

export function orderDetail(id: ID, edit: (order: Order) => void, addChanges: (order: Order, open?: Proposal) => void,
  openProposal: (id: ID) => void) {
  const details = resource(async () => {
    const { order, proposals } = await api.getOrder(id);
    const documents = await Promise.all(proposals.map(async (proposal) => {
      const detail = await api.getProposal(proposal.id);
      return {
        proposal: detail.proposal,
        current: detail.versions.find((version) => version.id === detail.proposal.currentVersionId),
        approved: detail.versions.find((version) => version.id === detail.proposal.approvedVersionId),
      };
    }));
    const open = documents.find(({ proposal }) => isOpen(proposal.status))?.proposal;
    return { order, documents, open };
  });

  const statusChange = mutation();
  const deletion = deleteDialog("Удалить заказ?", "Заказ и все его предложения будут удалены.", () => api.deleteOrder(id));
  const actions = dialog(
    UIText("Действия с заказом").style(type.card),
    errorNotice(statusChange.error),
    secondaryButton(() => {
      const state = details.state.value;
      if (statusChange.pending.value) return "Обновляем…";
      return state.status === "ready" && state.data.order.status === "completed" ? "Открыть снова" : "Завершить заказ";
    }, "toggle-order-status", () => {
      const state = details.state.value;
      if (state.status !== "ready") return;
      const status = state.data.order.status === "active" ? "completed" : "active";
      void statusChange.run(() => api.updateOrder(id, { status }), () => { actions.hide(); void details.load(); });
    }),
    secondaryButton("Удалить заказ", "delete-order", () => {
      if (statusChange.pending.value) return;
      actions.hide();
      deletion.show();
    }, true),
    secondaryButton("Закрыть", "close-order-menu", () => { if (!statusChange.pending.value) actions.hide(); }),
  ).onDismiss(() => { if (!statusChange.pending.value) actions.hide(); });

  const content = details.view(({ order, documents }) => [
    UIRow(
      UIColumn(
        pageTitle(order.title),
        order.serviceSnapshot && hint(order.serviceSnapshot.name),
        orderStatus(order.status),
      ).style({ flex: 1, minWidth: 0, gap: space.sm }),
      UIColumn(
        UIButton(icon(assetIcon("lucide:pencil"), colors.accentInk, 18))
          .style({ ...cardStyle, width: 44, height: 44, borderRadius: radius.control, $pressed: { backgroundColor: colors.ai } })
          .named("edit-order").onClick(() => edit(order)),
        UIButton(icon(assetIcon("lucide:ellipsis"), colors.text, 20))
          .style({ width: 44, height: 44, borderRadius: radius.control, $pressed: { backgroundColor: colors.control } })
          .named("order-menu").onClick(() => { statusChange.error.value = ""; actions.show(); }),
      ).style({ gap: space.xs }),
    ).style({ gap: space.md, alignItems: "flex-start" }),
    about(order),
    approvedChanges(documents.flatMap(({ approved }) => approved ? [approved] : [])),
    UIColumn(
      UIText("Правки").style({ ...type.card, fontSize: 20, lineHeight: 26 }),
      documents.length === 0
        ? emptyState("Правок пока нет", "Когда появятся новые пожелания, добавьте их к заказу.")
        : documents.map(({ proposal, current }) => UIButton(
          UIColumn(UIText(proposal.title).style(type.card),
            hint([proposalStatus[proposal.status], current && `Версия ${current.version}`].filter(Boolean).join(" · ")))
            .style({ flex: 1, minWidth: 0, gap: space.xs }),
          arrow(),
        ).style({ ...cardStyle, padding: space.lg, gap: space.md, $pressed: { backgroundColor: colors.ai } })
          .named(`proposal-${proposal.id}`).onClick(() => openProposal(proposal.id))),
    ).style({ gap: space.md }),
  ]);

  const screen = page("order-detail", pageBody(content), {
    onBack: () => Router.pop(),
    actionVisible: () => {
      const state = details.state.value;
      return state.status === "ready" && state.data.order.status === "active";
    },
    action: primaryButton(() => {
      const state = details.state.value;
      return state.status === "ready" && state.data.open ? "Добавить замечания" : "Добавить правки";
    }, "add-changes", () => {
      const state = details.state.value;
      if (state.status === "ready") addChanges(state.data.order, state.data.open);
    }, assetIcon("lucide:plus")),
  });
  return details.bind(screen.widgets(actions, deletion.modal));
}
