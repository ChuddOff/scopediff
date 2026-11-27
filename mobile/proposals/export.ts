import type { Order, Proposal, ProposalVersion, ShareFormat } from "../../shared/types";
import { api } from "../api/client";
import { formatDate, formatMoney, priceSummary } from "./model";

export function proposalText(orderTitle: string, version: ProposalVersion, markdown: boolean) {
  const text = (value: string) => markdown
    ? value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/[\\`*_{}\[\]()#+\-.!|~]/g, "\\$&")
    : value;
  const lines = [markdown ? `# ${text(version.title)}` : version.title, `Заказ: ${text(orderTitle)}`,
    `Версия ${version.version} · ${formatDate(version.createdAt)}`, ""];
  version.items.forEach((item, index) => {
    const title = `${index + 1}. ${text(item.title)}`;
    lines.push(markdown ? `### ${title}` : title);
    if (item.description) lines.push(text(item.description));
    lines.push(`Доплата: ${item.price === null ? "не определена" : formatMoney(item.price)}`, "");
  });
  const summary = priceSummary(version.items);
  if (summary.total !== null) lines.push(`Итоговая доплата: ${formatMoney(summary.total)}`);
  else {
    if (summary.unknown < version.items.length) lines.push(`Известная доплата: ${formatMoney(summary.known)}`);
    lines.push("Итоговая доплата пока не определена.");
  }
  if (version.deadline) lines.push(`Новый срок: ${formatDate(version.deadline)}`);
  if (version.conditions) lines.push("", markdown ? "## Дополнительные условия" : "Дополнительные условия", text(version.conditions));
  return lines.join("\n");
}

export async function prepareExport(order: Order, proposal: Proposal, version: ProposalVersion, format: ShareFormat) {
  const expectedVersionId = version.id;
  const preparation = { expectedVersionId, format };
  if (format === "link") {
    if (api.demo) throw exportError("Интерактивная ссылка появится после подключения сервера.");
    const published = await api.publishProposal(proposal.id, preparation);
    return { kind: "url" as const, url: browserUrl(published.proposal.shareUrl) };
  }
  if (format === "pdf") {
    if (!api.temporaryPdfUrl) throw exportError("PDF появится после подключения сервера.");
    const url = browserUrl(await api.temporaryPdfUrl(expectedVersionId));
    if (proposal.status === "draft") await api.publishProposal(proposal.id, preparation);
    return { kind: "url" as const, url };
  }
  const exported = proposal.status === "draft" ? (await api.publishProposal(proposal.id, preparation)).version : version;
  return { kind: "text" as const, markdown: proposalText(order.title, exported, true), plain: proposalText(order.title, exported, false) };
}

function exportError(message: string) {
  return { error: { code: "SERVICE_UNAVAILABLE", message } };
}

function browserUrl(value: string | null) {
  if (!value || !/^https:\/\/[^/\s]+(?:\/|$)/i.test(value)) throw exportError("Сервер пока не вернул ссылку для этого документа.");
  return value;
}
