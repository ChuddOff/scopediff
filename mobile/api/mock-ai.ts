import type { Order, OrderInput, ProposalContentInput, ProposalVersion, ServiceInput } from "../../shared/types";
import { parsePrice } from "../proposals/model";

export const aiExamples = {
  service: "Дизайн баннеров — Три формата, один раунд правок.\nДизайн рассылки — Макет одного письма и мобильная версия.",
  order: "Заказ: Промостраница для мастерской\nДоговорённости: Страница из пяти блоков\nВыполнено: Утвердили структуру\nПравки: Добавить раздел с отзывами",
  changes: "Добавить раздел с отзывами заказчиков",
};

export function exampleServices(text: string): ServiceInput[] {
  if (!text) return exampleServices(aiExamples.service);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const services = lines.map((line) => line.match(/^(.+?)\s+[—–-]\s+(.+)$/));
  if (services.every(Boolean)) {
    return services.map((match) => ({ name: match![1], description: match![2] }));
  }
  return [{ name: lines[0].split(/[.!?]/)[0].trim().slice(0, 120) || "Услуга из описания", description: text }];
}

export function exampleOrder(text: string, serviceId: OrderInput["serviceId"]) {
  const source = text || aiExamples.order;
  const field = (name: string) => source.match(new RegExp(`(?:^|\\n)[ \\t]*${name}[ \\t]*:[ \\t]*([^\\n]*)`, "i"))?.[1].trim() ?? "";
  const changes = field("(?:Новые[ \\t]+)?Правки") ||
    (source.match(/(?:^|[.!?\n]\s*)(?:клиент|заказчик)\s+(?:просит|попросил[аи]?)\s+дополнительно\s+([^.!?\n]+)/i)?.[1].trim() ?? "");
  const title = field("Заказ");
  const agreements = field("Договор[её]нности");
  const completedWork = field("Выполнено");
  const deadline = field("Срок") || null;
  const firstLine = source.split(/\r?\n/)[0].split(/[.!?]/)[0].trim();
  const input: OrderInput = {
    serviceId,
    title: title || firstLine.slice(0, 160) || "Заказ из описания",
    agreements: agreements || (title || changes || completedWork || deadline ? "" : source),
    completedWork,
    deadline,
  };
  return { input, changes };
}

function spokenChanges(text: string, previous: ProposalVersion) {
  const positions = ["перв", "втор", "трет", "четв", "пят", "шест", "седьм", "восьм", "девят", "десят"];
  const titleAt = (value: string) => {
    const number = /^\d+$/.test(value) ? Number(value) : positions.findIndex((prefix) => value.toLowerCase().startsWith(prefix)) + 1;
    return previous.items[number - 1]?.title;
  };
  return text.split(/\r?\n/).flatMap((line) => {
    if (/^\s*(?:Убрать|Условия|Срок|Цена|Дополнительно):/i.test(line)) return [line];
    return line.split(/[,;]\s*(?=(?:убери|удали|за|добавь)\s)/i).map((part) => {
      const remove = part.trim().match(/^(?:убери|удали)\s+(\S+)\s+пункт[.!]?$/i);
      const price = part.trim().match(/^за\s+(\S+)\s+(?:пункт\s+)?поставь\s+(.+?)[.!]?$/i);
      if (remove) {
        const title = titleAt(remove[1]);
        if (title) return `Убрать: ${title}`;
      }
      if (price) {
        const title = titleAt(price[1]);
        const value = price[2].trim().toLowerCase();
        const amount = value === "полторы тысячи" ? 1500 : parsePrice(value.replace(/\s*рублей$/, "").replace(/\s+/g, ""));
        if (title && amount !== null && Number.isFinite(amount)) return `Цена: ${title} — ${amount}`;
      }
      const add = part.trim().match(/^добавь\s+(.+)$/i)?.[1];
      return add ? `Добавить ${add}` : part;
    });
  });
}

export function exampleChanges(text: string, order: Order, approved: ProposalVersion[], previous?: ProposalVersion): ProposalContentInput {
  const normalize = (value: string) => value.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ").toLowerCase();
  const alreadyAgreed = new Set(order.agreements.split(/\n|[.!?](?:\s|$)/).map(normalize));
  const approvedWork = new Set(approved.flatMap((version) => [
    ...version.items.flatMap((item) => [item.title, item.description]), ...version.conditions.split(/\n|[.!?](?:\s|$)/),
  ]).map(normalize).filter(Boolean));
  const content: ProposalContentInput = {
    title: previous?.title ?? "Предложение по изменениям",
    items: previous?.items.map((item) => ({ ...item })) ?? [],
    deadline: previous?.deadline ?? null,
    conditions: previous?.conditions ?? "",
    comment: previous?.comment ?? null,
  };

  const lines = previous ? spokenChanges(text, previous) : text.split(/\r?\n/);
  for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
    const command = line.match(/^(Убрать|Условия|Срок|Цена):\s*(.+)$/i);
    if (command) {
      const value = command[2];
      switch (command[1].toLowerCase()) {
        case "убрать": content.items = content.items.filter((item) => normalize(item.title) !== normalize(value)); break;
        case "условия": content.conditions = value; break;
        case "срок": content.deadline = value === "без изменения" ? null : value; break;
        case "цена": {
          const pair = value.match(/^(.+?)\s+[—–-]\s+(.+)$/);
          const item = pair && content.items.find((entry) => normalize(entry.title) === normalize(pair[1]));
          if (item && pair) item.price = pair[2] === "не определена" ? null : (parsePrice(pair[2]) ?? null);
          break;
        }
      }
      continue;
    }
    const work = line.replace(/^[-•]\s+/, "");
    const explicitlyExtra = /^Дополнительно:\s*/i.test(work);
    const [title, description] = work.replace(/^Дополнительно:\s*/i, "").split(/\s+[—–]\s+(.+)/, 2);
    const key = normalize(title);
    if (!key || content.items.some((item) => normalize(item.title) === key)) continue;
    const included = approvedWork.has(key) || alreadyAgreed.has(key);
    content.items.push({
      id: null, title: title.slice(0, 160), description: description ?? title, price: null,
      category: included ? "included" : explicitlyExtra ? "extra" : "unclear",
      reason: approvedWork.has(key) ? "Эта работа уже указана в согласованных правках."
        : included ? "Эта работа совпадает с исходными договорённостями."
          : explicitlyExtra ? "Работа явно указана как дополнительная." : "Требуется уточнить условия работы.",
    });
  }
  return content;
}
