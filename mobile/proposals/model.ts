import type { ChangeCategory, ChangeItem, ProposalStatus } from "../../shared/types";

export const proposalStatus = {
  draft: "Черновик", pending: "На согласовании", countered: "Заказчик предложил изменения",
  approved: "Согласовано", rejected: "Отклонено",
};

export const categoryLabels: Record<ChangeCategory, string> = {
  included: "В рамках договорённостей", extra: "Дополнительная работа", unclear: "Требует уточнения",
};

export function isOpen(status: ProposalStatus) {
  return status === "draft" || status === "pending" || status === "countered";
}

export function formatDate(value: string) {
  return date(`${value.slice(0, 10)}T00:00:00`).format("D MMMM YYYY", "ru");
}

export function formatMoney(value: number) {
  return `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f")} ₽`;
}

export function priceSummary(items: ReadonlyArray<Pick<ChangeItem, "price">>) {
  let known = 0;
  let unknown = 0;
  for (const { price } of items) {
    if (price === null) unknown++;
    else known += price;
  }
  return { known, unknown, total: unknown ? null : known };
}

export function parsePrice(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const price = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(price) ? price : NaN;
}
