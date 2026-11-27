import type { ID, Proposal, ProposalVersion, ShareFormat } from "../../shared/types";
import { api, isConflict, isOutcomeUnknown } from "../api/client";
import { prepareExport } from "../proposals/export";
import { isOpen } from "../proposals/model";
import { errorNotice, mutation, resource } from "../ui/async";
import { card, cardStyle, dialog, hint, icon, page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { proposalDocument, statusStamp } from "../ui/proposal-document";
import { colors, radius, space, type } from "../ui/theme";
import { proposalEditor } from "./proposal-editor";
import { textExport, urlExport } from "./proposal-export";
import { comparisonScreen, versionHistory } from "./proposal-history";

type Confirm = "approve" | "reject" | "revoke-link";

const confirmationCopy = {
  approve: { title: "Зафиксировать согласование?", body: "Эта версия будет добавлена к договорённостям заказа.", button: "Подтвердить согласование" },
  reject: { title: "Отклонить предложение?", body: "Предложение закроется. Договорённости заказа сохранятся.", button: "Подтвердить отклонение" },
  "revoke-link": { title: "Отозвать ссылку?", body: "Заказчик потеряет доступ по этой ссылке.", button: "Отозвать ссылку" },
};

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

  function reloadAfterFailure(error: unknown) { if (isConflict(error) || isOutcomeUnknown(error)) void document.load(); }

  function dismiss(modal: UIModal) { if (!action.pending.value) modal.hide(); }

  function exportFormat(format: ShareFormat) {
    const data = current();
    if (!data || historyOnly) return;
    void action.run(() => prepareExport(data.order, data.proposal, data.version, format), (result) => {
      exports.hide();
      Router.push(result.kind === "text" ? textExport(result.markdown, result.plain) : urlExport(result.url, format === "pdf"));
    }, reloadAfterFailure);
  }

  const exports = dialog(
    UIText("Поделиться предложением").style(type.card),
    errorNotice(action.error),
    secondaryButton(api.demo ? "Интерактивная ссылка · нужен сервер" : "Интерактивная ссылка", "share-link", () => exportFormat("link")),
    secondaryButton(api.temporaryPdfUrl ? "PDF" : "PDF · недоступен", "share-pdf", () => exportFormat("pdf")),
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
    UIText(() => confirm.value ? confirmationCopy[confirm.value.kind].title : "").style(type.card),
    hint(() => confirm.value ? confirmationCopy[confirm.value.kind].body : ""),
    errorNotice(action.error),
    secondaryButton(() => action.pending.value ? "Сохраняем…" : confirm.value ? confirmationCopy[confirm.value.kind].button : "",
      "confirm-proposal-action", () => {
        const operation = confirm.value;
        if (!operation || historyOnly || confirmationStale.value) return;
        const update = operation.kind === "approve" ? api.approveProposal : operation.kind === "reject" ? api.rejectProposal : api.revokeLink;
        if (!update) return;
        void action.run(() => update(id, { expectedVersionId: operation.versionId }), () => {
          confirmation.hide();
          void document.load();
        }, (error) => {
          confirmationStale.value = isConflict(error) || isOutcomeUnknown(error);
          reloadAfterFailure(error);
        });
      }).style({ display: () => confirmationStale.value ? "none" : "flex" }),
    secondaryButton("Отмена", "cancel-proposal-action", () => dismiss(confirmation)),
  ).onDismiss(() => dismiss(confirmation));

  function demoCounter(version: ProposalVersion) {
    const respond = api.respondToDemoCounter;
    if (!api.demo || !respond || historyOnly) return;
    void action.run(() => respond(id, { expectedVersionId: version.id }),
      () => { actions.hide(); void document.load(); }, reloadAfterFailure);
  }

  const menuItems = UIColumn(() => {
    const data = current();
    if (!data || historyOnly) return [];
    const { proposal, version } = data;
    const editable = isOpen(proposal.status);
    return [
      secondaryButton(() => document.loading.value ? "Обновляем…" : "Обновить предложение", "refresh-proposal", async () => {
        if (action.pending.value || document.loading.value) return;
        await document.refresh();
        actions.hide();
      }),
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
        }, reloadAfterFailure);
      }) : null,
      proposal.status === "pending" || proposal.status === "countered" ? secondaryButton("Зафиксировать согласование", "approve-proposal", () => askConfirmation("approve")) : null,
      editable ? secondaryButton("Отклонить", "reject-proposal", () => askConfirmation("reject"), true) : null,
      proposal.shareUrl && api.revokeLink ? secondaryButton("Отозвать ссылку", "revoke-proposal-link", () => askConfirmation("revoke-link"), true) : null,
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
