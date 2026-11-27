import type { ID, Order, Proposal, ProposalVersion, ShareFormat } from "../../shared/types";
import { api, isConflict, isOutcomeUnknown } from "../api/client";
import { prepareExport } from "../proposals/export";
import { currentRound, isOpen } from "../proposals/model";
import { errorNotice, mutation, resource } from "../ui/async";
import { actionMenu, aiAction, card, cardStyle, dialog, hint, icon, menuAction, page, pageBody, pageTitle,
  primaryButton, secondaryButton } from "../ui/components";
import { proposalDocument, statusStamp } from "../ui/proposal-document";
import { colors, radius, space, type } from "../ui/theme";
import type { AiMode } from "./ai-input";
import { proposalEditor } from "./proposal-editor";
import { textExport, urlExport } from "./proposal-export";
import { comparisonScreen, versionHistory } from "./proposal-history";

type Confirm = "approve" | "reject" | "revoke-link";

const confirmationCopy = {
  approve: { title: "Зафиксировать согласование?", body: "Эта версия будет добавлена к договорённостям заказа.", button: "Подтвердить согласование" },
  reject: { title: "Отклонить правки?", body: "Раунд завершится. Договорённости заказа сохранятся.", button: "Подтвердить отклонение" },
  "revoke-link": { title: "Отозвать ссылку?", body: "Заказчик потеряет доступ по этой ссылке.", button: "Отозвать ссылку" },
};

export function proposalScreen(orderId: ID, historical: { proposalId: ID; versionId: ID } | undefined,
  change: (order: Order, proposal?: Proposal, mode?: AiMode) => void, openVersion: (proposalId: ID, versionId: ID) => void) {
  const historyOnly = historical !== undefined;
  const document = resource(async () => {
    const { order, proposals } = await api.getOrder(orderId);
    const id = historical?.proposalId ?? currentRound(proposals)?.id;
    if (!id) throw { error: { code: "NOT_FOUND", message: "Правки не найдены." } };
    const detail = await api.getProposal(id);
    const targetId = historical?.versionId ?? detail.proposal.currentVersionId;
    const index = detail.versions.findIndex((entry) => entry.id === targetId);
    if (index === -1) throw { error: { code: "NOT_FOUND", message: "Версия правок не найдена." } };
    return { proposal: detail.proposal, order, version: detail.versions[index], previous: detail.versions[index - 1] };
  });
  const action = mutation();
  const confirm = signal<{ kind: Confirm; proposalId: ID; versionId: ID } | null>(null);
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
    UIText("Поделиться правками").style(type.card),
    errorNotice(action.error),
    secondaryButton(api.demo ? "Интерактивная ссылка · нужен сервер" : "Интерактивная ссылка", "share-link", () => exportFormat("link")),
    secondaryButton(api.temporaryPdfUrl ? "PDF" : "PDF · недоступен", "share-pdf", () => exportFormat("pdf")),
    secondaryButton(() => action.pending.value ? "Готовим документ…" : "Markdown", "share-markdown", () => exportFormat("markdown")),
    secondaryButton("Закрыть", "close-share", () => dismiss(exports)),
  ).onDismiss(() => dismiss(exports));

  function askConfirmation(kind: Confirm) {
    const data = current();
    if (!data || action.pending.value) return;
    confirm.value = { kind, proposalId: data.proposal.id, versionId: data.version.id };
    confirmationStale.value = false;
    action.error.value = "";
    actions.hide();
    confirmation.show();
  }

  const closeConfirmation = () => {
    if (action.pending.value) return;
    confirmation.hide();
    confirm.value = null;
    action.error.value = "";
  };
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
        void action.run(() => update(operation.proposalId, { expectedVersionId: operation.versionId }), () => {
          closeConfirmation();
          void document.load();
        }, (error) => {
          confirmationStale.value = isConflict(error) || isOutcomeUnknown(error);
          reloadAfterFailure(error);
        });
      }).style({ display: () => confirmationStale.value ? "none" : "flex" }),
    secondaryButton("Отмена", "cancel-proposal-action", closeConfirmation),
  ).onDismiss(closeConfirmation);

  function demoCounter(proposal: Proposal, version: ProposalVersion) {
    const respond = api.respondToDemoCounter;
    if (!api.demo || !respond || historyOnly) return;
    void action.run(() => respond(proposal.id, { expectedVersionId: version.id }),
      () => { actions.hide(); void document.load(); }, reloadAfterFailure);
  }

  function prepare(proposal: Proposal, version: ProposalVersion) {
    void action.run(() => api.publishProposal(proposal.id, { expectedVersionId: version.id, format: "text" }),
      () => { actions.hide(); void document.load(); }, reloadAfterFailure);
  }

  const menuItems = UIColumn(() => {
    const data = current();
    if (!data || historyOnly) return [];
    const { order, proposal, version, previous } = data;
    const editable = isOpen(proposal.status);
    return [
      menuAction("История версий", "open-history", assetIcon("lucide:history"), () => {
        if (action.pending.value) return;
        actions.hide();
        Router.push(versionHistory(orderId, openVersion));
      }),
      previous ? menuAction(`Сравнить с версией ${previous.version}`, "compare-versions", assetIcon("lucide:git-compare"), () => {
        if (action.pending.value) return;
        actions.hide();
        Router.push(comparisonScreen(previous, version));
      }) : null,
      order.status === "active" && editable ? menuAction("Изменить правки", "proposal-revise", assetIcon("lucide:pencil-line"), () => {
        if (action.pending.value) return;
        actions.hide();
        change(order, proposal);
      }) : null,
      menuAction(() => document.loading.value ? "Обновляем…" : "Обновить правки", "refresh-proposal", assetIcon("lucide:refresh-cw"), async () => {
        if (action.pending.value || document.loading.value) return;
        await document.refresh();
        actions.hide();
      }),
      editable ? menuAction("Отклонить", "reject-proposal", assetIcon("lucide:circle-x"), () => askConfirmation("reject")) : null,
      proposal.shareUrl && api.revokeLink
        ? menuAction("Отозвать ссылку", "revoke-proposal-link", assetIcon("lucide:unlink"), () => askConfirmation("revoke-link")) : null,
      api.demo && api.respondToDemoCounter && proposal.status === "pending"
        ? menuAction("Демо: встречное предложение", "demo-counter", assetIcon("lucide:message-square"), () => demoCounter(proposal, version)) : null,
    ];
  }).style({ gap: space.sm });

  const actions = actionMenu("Действия с правками", "close-proposal-menu",
    UIColumn(errorNotice(action.error), menuItems).style({ gap: space.sm }), () => !action.pending.value);

  function iconButton(name: string, image: SvgSource, onClick: () => void) {
    return UIButton(icon(image, colors.accentInk, 19)).style({
      ...cardStyle, width: 44, height: 44, borderRadius: radius.control, $pressed: { backgroundColor: colors.ai },
    }).named(name).onClick(onClick);
  }

  const body = document.view(({ order, proposal, version }) => {
    const countered = !historyOnly && proposal.status === "countered";
    const editable = !historyOnly && order.status === "active" && isOpen(proposal.status);
    const edit = () => { if (!action.pending.value) Router.push(proposalEditor(order, proposal, version)); };
    return [
      UIRow(
        pageTitle("Правки").style({ flex: 1, minWidth: 0 }),
        editable ? iconButton("edit-proposal", assetIcon("lucide:pencil"), edit) : null,
        !historyOnly ? iconButton("proposal-menu", assetIcon("lucide:ellipsis"), () => { if (!action.pending.value) actions.show(); }) : null,
      ).style({ alignItems: "center", gap: space.sm }),
      hint(order.title),
      UIRow(
        version.id === proposal.currentVersionId ? statusStamp(proposal.status) : null,
        hint(`Версия ${version.version}${historyOnly ? " · только просмотр" : ""}`),
      ).style({ gap: space.sm, alignItems: "center", flexWrap: "wrap" }),
      !historyOnly ? errorNotice(action.error).style({ display: () => action.error.value && !confirm.value ? "flex" : "none" }) : null,
      editable ? aiAction("Изменить голосом", "Расскажите, что добавить, изменить или убрать", "revise-by-voice",
        assetIcon("lucide:mic"), () => { if (!action.pending.value) change(order, proposal, "voice"); }) : null,
      !historyOnly && !editable && order.status === "active" ? secondaryButton("Дополнить правки", "next-round", () => {
        if (!action.pending.value) change(order);
      }) : null,
      editable && proposal.status === "draft" ? secondaryButton(
        () => action.pending.value ? "Готовим документ…" : "Подготовить к согласованию", "prepare-proposal",
        () => prepare(proposal, version),
      ) : null,
      editable && proposal.status === "pending"
        ? secondaryButton("Зафиксировать согласование", "approve-proposal", () => askConfirmation("approve")) : null,
      countered ? card(
        UIText("Встречные условия заказчика").style(type.card),
        secondaryButton("Принять изменения", "accept-counter", () => askConfirmation("approve")),
        secondaryButton("Предложить свои условия", "edit-counter", edit),
      ).style({ backgroundColor: colors.warningSurface, gap: space.sm }) : null,
      proposalDocument(version),
    ];
  }, space.md);

  return document.bind(page(historyOnly ? "proposal-version" : "proposal", pageBody(body), {
    onBack: () => { if (!action.pending.value) Router.pop(); },
    actionVisible: () => current() !== null,
    action: historyOnly ? undefined : primaryButton("Поделиться", "share-proposal", () => {
      action.error.value = "";
      exports.show();
    }, assetIcon("lucide:share-2")),
  }).widgets(exports, actions, confirmation), true);
}
