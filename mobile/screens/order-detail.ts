import type { ID, Order } from "../../shared/types";
import { api, isConflict, isOutcomeUnknown } from "../api/client";
import { currentRound, formatDate, proposalStatus } from "../proposals/model";
import { errorNotice, mutation, resource } from "../ui/async";
import { actionMenu, arrow, card, cardStyle, emptyState, hint, menuAction, page, pageBody,
  primaryButton, recordHeader, recordTitle, secondaryButton } from "../ui/components";
import { deleteDialog } from "../ui/delete-dialog";
import { colors, space, type } from "../ui/theme";
import { orderStatus } from "./orders";

function about(order: Order) {
  const expanded = signal(false);
  const collapsible = order.agreements.length > 160 || order.agreements.split("\n").length > 4;
  return card(
    UIText("Описание").style(type.card),
    hint(order.agreements || "Описание пока не добавлено.").style({ lineClamp: () => collapsible && !expanded.value ? 4 : 0 }),
    collapsible ? secondaryButton(() => expanded.value ? "Свернуть" : "Показать полностью", "toggle-agreements", () => {
      expanded.value = !expanded.value;
    }).style({ alignSelf: "flex-start" }) : null,
    order.deadline ? hint(`Срок · ${formatDate(order.deadline)}`) : null,
  ).style({ gap: space.sm });
}

export function orderDetail(id: ID, edit: (order: Order) => void, createChanges: (order: Order) => void, openChanges: () => void) {
  const details = resource(async () => {
    const { order, proposals } = await api.getOrder(id);
    const selected = currentRound(proposals);
    if (!selected) return { order, summary: null };
    const { proposal, versions } = await api.getProposal(selected.id);
    const version = versions.find((entry) => entry.id === proposal.currentVersionId);
    return { order, summary: { status: proposal.status, version: version?.version, count: version?.items.length } };
  });

  const statusChange = mutation();
  const deletion = deleteDialog("Удалить заказ?", "Заказ и все его правки будут удалены.", () => api.deleteOrder(id), details.load);
  const reopen = () => {
    const state = details.state.value;
    return state.status === "ready" && state.data.order.status === "completed";
  };
  const actions = actionMenu("Действия с заказом", "close-order-menu", UIColumn(
    errorNotice(statusChange.error),
    UIColumn(() => [menuAction(() => statusChange.pending.value ? "Обновляем…" : reopen() ? "Открыть снова" : "Завершить заказ",
      "toggle-order-status", reopen() ? assetIcon("lucide:rotate-ccw") : assetIcon("lucide:circle-check"), () => {
        const state = details.state.value;
        if (state.status !== "ready") return;
        const status = reopen() ? "active" : "completed";
        void statusChange.run(() => api.updateOrder(id, { status }), () => { actions.hide(); void details.load(); }, (error) => {
          if (isConflict(error) || isOutcomeUnknown(error)) void details.load();
        });
      })]),
    menuAction("Удалить заказ", "delete-order", assetIcon("lucide:trash-2"), () => {
      if (statusChange.pending.value) return;
      actions.hide();
      deletion.show();
    }, true),
  ).style({ gap: space.sm }), () => !statusChange.pending.value);

  const content = details.view(({ order, summary }) => [
    recordHeader(
      UIColumn(recordTitle(order.title, order.serviceSnapshot?.name), orderStatus(order.status)).style({ gap: space.sm }),
      "order", () => edit(order), () => { statusChange.error.value = ""; actions.show(); },
    ),
    about(order),
    summary ? UIButton(
      UIColumn(UIText("Правки").style(type.card),
        hint([
          proposalStatus[summary.status],
          summary.version !== undefined ? `Версия ${summary.version}` : "",
          summary.count !== undefined ? `Пунктов: ${summary.count}` : "",
        ].filter(Boolean).join(" · ")),
      ).style({ flex: 1, minWidth: 0, gap: space.xs }), arrow(),
    ).style({ ...cardStyle, padding: space.lg, gap: space.md, $pressed: { backgroundColor: colors.ai } })
      .named("order-changes").onClick(openChanges)
      : emptyState("Правок пока нет", order.status === "completed"
        ? "В этом заказе не было правок."
        : "Когда появятся новые пожелания, создайте список правок."),
  ]);

  const screen = page("order-detail", pageBody(content), {
    onBack: () => Router.pop(),
    actionVisible: () => {
      const state = details.state.value;
      return state.status === "ready" && state.data.order.status === "active" && !state.data.summary;
    },
    action: primaryButton("Создать правки", "add-changes", () => {
      const state = details.state.value;
      if (state.status === "ready" && state.data.order.status === "active" && !state.data.summary) createChanges(state.data.order);
    }, assetIcon("lucide:plus")),
  });
  return details.bind(screen.widgets(actions, deletion.modal), true);
}
