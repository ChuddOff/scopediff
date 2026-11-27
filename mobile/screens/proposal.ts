import type { ID, Proposal, ProposalVersion, ShareFormat } from "../../shared/types";
import { api, isConflict } from "../api/client";
import { prepareExport } from "../proposals/export";
import { isOpen } from "../proposals/model";
import { errorNotice, mutation, resource } from "../ui/async";
import { card, cardStyle, dialog, hint, icon, page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { proposalDocument, statusStamp } from "../ui/proposal-document";
import { colors, radius, space, type } from "../ui/theme";
import { proposalEditor } from "./proposal-editor";
import { textExport, urlExport } from "./proposal-export";
import { comparisonScreen, versionHistory } from "./proposal-history";

type Confirm = "approve" | "reject";

export function proposalScreen(id: ID, versionId: ID | undefined, revise: (proposal: Proposal) => void, openVersion: (id: ID) => void) {
  const historyOnly = versionId !== undefined;
  const document = resource(async () => {
    const detail = await api.getProposal(id);
    const order = (await api.getOrder(detail.proposal.orderId)).order;
    const targetId = versionId ?? detail.proposal.currentVersionId;
    const index = detail.versions.findIndex((entry) => entry.id === targetId);
    if (index === -1) throw { error: { code: "NOT_FOUND", message: "Версия предложения не найдена." } };
    return { proposal: detail.proposal, order, version: detail.versions[index], previous: detail.versions[index - 1] };
  });
  const action = mutation();
  const confirm = signal<{ kind: Confirm; versionId: ID } | null>(null);
  const confirmationStale = signal(false);

  function current() {
    const state = document.state.value;
    return state.status === "ready" ? state.data : null;
  }

  function reloadOnConflict(error: unknown) { if (isConflict(error)) void document.load(); }

  function dismiss(modal: UIModal) { if (!action.pending.value) modal.hide(); }

  function exportFormat(format: ShareFormat) {
    const data = current();
    if (!data || historyOnly) return;
    void action.run(() => prepareExport(data.order, data.proposal, data.version, format), (result) => {
      exports.hide();
      Router.push(result.kind === "text" ? textExport(result.markdown, result.plain) : urlExport(result.url, format === "pdf"));
    }, reloadOnConflict);
  }

  const serverLabel = (name: string) => api.demo ? `${name} · нужен сервер` : name;
  const exports = dialog(
    UIText("Поделиться предложением").style(type.card),
    errorNotice(action.error),
    secondaryButton(serverLabel("Интерактивная ссылка"), "share-link", () => exportFormat("link")),
    secondaryButton(serverLabel("PDF"), "share-pdf", () => exportFormat("pdf")),
    secondaryButton(() => action.pending.value ? "Готовим документ…" : "Markdown", "share-markdown", () => exportFormat("markdown")),
    secondaryButton("Закрыть", "close-share", () => dismiss(exports)),
  ).onDismiss(() => dismiss(exports));

  function askConfirmation(kind: Confirm) {
    const data = current();
    if (!data || action.pending.value) return;
    confirm.value = { kind, versionId: data.version.id };
    confirmationStale.value = false;
    action.error.value = "";
    actions.hide();
    confirmation.show();
  }

  const confirmation = dialog(
    UIText(() => confirm.value?.kind === "approve" ? "Зафиксировать согласование?" : "Отклонить предложение?").style(type.card),
    hint(() => confirm.value?.kind === "approve" ? "Эта версия будет добавлена к договорённостям заказа." : "Предложение закроется. Договорённости заказа сохранятся."),
    errorNotice(action.error),
    secondaryButton(() => action.pending.value ? "Сохраняем…" : confirm.value?.kind === "approve" ? "Подтвердить согласование" : "Подтвердить отклонение",
      "confirm-proposal-action", () => {
        const operation = confirm.value;
        if (!operation || historyOnly || confirmationStale.value) return;
        const update = operation.kind === "approve" ? api.approveProposal : api.rejectProposal;
        void action.run(() => update(id, { expectedVersionId: operation.versionId }), () => {
          confirmation.hide();
          void document.load();
        }, (error) => {
          confirmationStale.value = isConflict(error);
          reloadOnConflict(error);
        });
      }).style({ display: () => confirmationStale.value ? "none" : "flex" }),
    secondaryButton("Отмена", "cancel-proposal-action", () => dismiss(confirmation)),
  ).onDismiss(() => dismiss(confirmation));

  function demoCounter(version: ProposalVersion) {
    const respond = api.respondToDemoCounter;
    if (!api.demo || !respond || historyOnly) return;
    const items = version.items.map(({ id, title, description, price }, index) => ({
      id, title, description, price: index === 0 && price !== null ? Math.floor(price * 0.9) : price,
    }));
    void action.run(() => respond(id, {
      expectedVersionId: version.id,
      content: {
        items, deadline: version.deadline,
        conditions: [version.conditions, "Демонстрационный ответ: согласовать макеты перед финальной передачей."].filter(Boolean).join("\n"),
        comment: "Пример ответа заказчика",
      },
    }), () => { actions.hide(); void document.load(); }, reloadOnConflict);
  }

  const menuItems = UIColumn(() => {
    const data = current();
    if (!data || historyOnly) return [];
    const { proposal, version } = data;
    const editable = isOpen(proposal.status);
    return [
      secondaryButton("История версий", "open-history", () => {
        if (action.pending.value) return;
        actions.hide();
        Router.push(versionHistory(id, openVersion));
      }),
      editable ? secondaryButton("Добавить замечания", "proposal-revise", () => {
        if (action.pending.value) return;
        actions.hide();
        revise(proposal);
      }) : null,
      proposal.status === "draft" ? secondaryButton("Подготовить к согласованию", "prepare-proposal", () => {
        void action.run(() => api.publishProposal(id, { expectedVersionId: version.id, format: "text" }), () => {
          actions.hide();
          void document.load();
        }, reloadOnConflict);
      }) : null,
      proposal.status === "pending" || proposal.status === "countered" ? secondaryButton("Зафиксировать согласование", "approve-proposal", () => askConfirmation("approve")) : null,
      editable ? secondaryButton("Отклонить", "reject-proposal", () => askConfirmation("reject"), true) : null,
      api.demo && api.respondToDemoCounter && proposal.status === "pending"
        ? secondaryButton("Демо: встречное предложение", "demo-counter", () => demoCounter(version)) : null,
    ];
  }).style({ gap: space.sm });

  const actions = dialog(
    UIText("Действия с предложением").style(type.card),
    errorNotice(action.error), menuItems,
    secondaryButton("Закрыть", "close-proposal-menu", () => dismiss(actions)),
  ).onDismiss(() => dismiss(actions));

  function iconButton(name: string, image: SvgSource, onClick: () => void) {
    return UIButton(icon(image, colors.accentInk, 19)).style({
      ...cardStyle, width: 44, height: 44, borderRadius: radius.control, $pressed: { backgroundColor: colors.ai },
    }).named(name).onClick(onClick);
  }

  const body = document.view(({ order, proposal, version, previous }) => {
    const countered = !historyOnly && proposal.status === "countered";
    const comparison = previous ? secondaryButton(`Сравнить с версией ${previous.version}`, "compare-versions", () => {
      Router.push(comparisonScreen(previous, version));
    }) : null;
    return [
      UIRow(
        pageTitle("Предложение").style({ flex: 1, minWidth: 0, fontSize: "clamp(21px, 7vw, 28px)", lineHeight: 36 }),
        !historyOnly && isOpen(proposal.status) ? iconButton("edit-proposal", assetIcon("lucide:pencil"), () => Router.push(proposalEditor(proposal, version))) : null,
        !historyOnly ? iconButton("proposal-menu", assetIcon("lucide:ellipsis"), () => { action.error.value = ""; actions.show(); }) : null,
      ).style({ alignItems: "center", gap: space.sm }),
      UIRow(
        version.id === proposal.currentVersionId ? statusStamp(proposal.status) : null,
        hint(`Версия ${version.version}${historyOnly ? " · только просмотр" : ""}`),
      ).style({ gap: space.sm, alignItems: "center", flexWrap: "wrap" }),
      countered ? card(
        UIText("Встречные условия заказчика").style(type.card), comparison,
        secondaryButton("Принять изменения", "accept-counter", () => askConfirmation("approve")),
        secondaryButton("Предложить свои условия", "edit-counter", () => Router.push(proposalEditor(proposal, version))),
      ).style({ backgroundColor: colors.warningSurface, gap: space.sm }) : null,
      !countered ? comparison : null,
      proposalDocument(order, version),
    ];
  }, space.md);

  return document.bind(page(historyOnly ? "proposal-version" : "proposal", pageBody(body), {
    onBack: () => { if (!action.pending.value) Router.pop(); },
    actionVisible: () => current() !== null,
    action: historyOnly ? undefined : primaryButton("Поделиться", "share-proposal", () => {
      action.error.value = "";
      exports.show();
    }, assetIcon("lucide:share-2")),
  }).widgets(exports, actions, confirmation));
}
