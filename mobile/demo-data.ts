import type { Order, Service } from "../shared/types";

const branding: Service = {
  id: "branding",
  name: "Айдентика бренда",
  description: "Логотип, палитра, типографика и краткое руководство по стилю. Две концепции и два раунда правок к выбранной. Дизайн упаковки и печатных материалов обсуждается отдельно.",
};

const presentation: Service = {
  id: "presentation",
  name: "Дизайн презентации",
  description: "Визуальная концепция и оформление до 15 слайдов. Два раунда правок, исходник и PDF.",
};

const social: Service = {
  id: "social",
  name: "Оформление соцсетей",
  description: "Обложки и набор шаблонов для публикаций и сторис. Передача редактируемых макетов.",
};

const landing: Service = {
  id: "landing",
  name: "Дизайн лендинга",
  description: "Структура и дизайн страницы в полной и мобильной версиях. До двух раундов правок. Вёрстка обсуждается отдельно.",
};

// Каталог отсортирован по названию, как в ответе API.
export const demoServices: Service[] = [branding, landing, presentation, social];

export const demoOrders: Order[] = [
  {
    id: "studio-landing",
    serviceId: landing.id,
    serviceSnapshot: { ...landing },
    title: "Лендинг для студии йоги",
    agreements: "Пять блоков, адаптивный макет и два раунда правок.",
    completedWork: "Согласована структура страницы.",
    deadline: "2026-12-04",
    status: "active",
    revision: 1,
    createdAt: "2026-11-20T09:00:00Z",
    updatedAt: "2026-11-26T12:00:00Z",
  },
  {
    id: "coffee-branding",
    serviceId: branding.id,
    serviceSnapshot: { ...branding },
    title: "Айдентика для кофейни «Зёрна»",
    agreements: "Логотип, цветовая палитра и правила применения на вывеске.",
    completedWork: "Отправлены две концепции.",
    deadline: "2026-12-06",
    status: "active",
    revision: 1,
    createdAt: "2026-11-16T08:30:00Z",
    updatedAt: "2026-11-27T10:30:00Z",
  },
  {
    id: "spring-materials",
    serviceId: null,
    serviceSnapshot: null,
    title: "Макеты для весеннего запуска",
    agreements: "Ключевой визуал и три формата баннеров.",
    completedWork: "",
    deadline: null,
    status: "active",
    revision: 1,
    createdAt: "2026-11-24T14:00:00Z",
    updatedAt: "2026-11-24T14:00:00Z",
  },
  {
    id: "market-presentation",
    serviceId: presentation.id,
    serviceSnapshot: { ...presentation },
    title: "Презентация для городского маркета",
    agreements: "Оформление 12 слайдов.",
    completedWork: "Переданы исходник и PDF.",
    deadline: "2026-11-19",
    status: "completed",
    revision: 1,
    createdAt: "2026-11-08T10:00:00Z",
    updatedAt: "2026-11-19T13:00:00Z",
  },
  {
    id: "social-templates",
    serviceId: social.id,
    serviceSnapshot: { ...social },
    title: "Шаблоны для цветочной мастерской",
    agreements: "Шесть шаблонов для публикаций и сторис.",
    completedWork: "Переданы шаблоны и памятка по использованию.",
    deadline: null,
    status: "completed",
    revision: 1,
    createdAt: "2026-11-10T11:00:00Z",
    updatedAt: "2026-11-22T10:15:00Z",
  },
];
