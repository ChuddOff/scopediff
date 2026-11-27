import type { OrderStatus, OrderSummary } from "../../shared/types";
import { api } from "../api/client";
import { resource } from "../ui/async";
import { cardStyle, emptyState, page, pageBody, pageTitle, primaryButton } from "../ui/components";
import { colors, radius, space, type } from "../ui/theme";

const statusLabels = { active: "В работе", completed: "Завершён" };

export function orderStatus(status: OrderStatus) {
  const completed = status === "completed";
  const color = completed ? colors.successInk : colors.accentInk;
  const background = completed ? colors.successSurface : colors.ai;
  return UIText(statusLabels[status]).style({
    ...type.label, color, backgroundColor: background, paddingHorizontal: space.sm,
    paddingVertical: space.xs, borderRadius: radius.control, flexShrink: 0, alignSelf: "flex-start",
  });
}

function orderCard(order: OrderSummary, onOpen: () => void) {
  return UIButton(
    UIText(order.title).style({ ...type.card, lineClamp: 2 }),
    UIRow(
      UIText(order.serviceSnapshot?.name ?? "Услуга не выбрана").style({
        ...type.small,
        color: colors.textMuted,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        lineClamp: 1,
      }),
      orderStatus(order.status),
    ).style({ alignItems: "center", gap: space.sm }),
  ).style({
    ...cardStyle, flexDirection: "column", alignItems: "stretch", padding: space.lg,
    gap: space.xs, $pressed: { backgroundColor: colors.ai },
  }).named(`order-${order.id}`).onClick(onOpen);
}

function activeCount(count: () => number | null) {
  return UIRow(
    UIBox().style({ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }),
    UIText(() => `${count() ?? 0} в работе`).style({ ...type.label, color: colors.accentInk }),
  ).style({
    alignItems: "center",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.sm,
    backgroundColor: colors.ai,
    borderRadius: radius.control,
    flexShrink: 0,
    display: () => count() === null ? "none" : "flex",
  }).named("active-count");
}

export function ordersScreen(onCreate: () => void, onOpen: (id: string) => void, onBack?: () => void) {
  const filter = signal<OrderStatus>("active");
  const orders = resource(api.listOrders);

  function filterButton(status: OrderStatus, label: string) {
    return UIButton(UIText(label).style({
      ...type.label,
      color: colors.textMuted,
      textAlign: "center",
      $selected: { color: colors.text },
    })).style({
      flex: 1,
      minHeight: 42,
      borderRadius: radius.control,
      $selected: { backgroundColor: colors.surface, boxShadow: "0 1px 3px rgba(17,24,39,.09)" },
    }).class({ selected: () => filter.value === status })
      .named(`filter-${status}`)
      .onClick(() => { filter.value = status; });
  }

  const filters = UIRow(
    filterButton("active", "Активные"),
    filterButton("completed", "Завершённые"),
  ).style({ padding: space.xs, gap: space.xs, borderRadius: radius.card, backgroundColor: colors.control });

  const heading = UIRow(pageTitle("Заказы"), activeCount(() => {
    const state = orders.state.value;
    return state.status === "ready" ? state.data.filter((order) => order.status === "active").length : null;
  })).style({ alignItems: "center", justifyContent: "space-between", gap: space.md });

  const list = orders.view((items) => {
    const visible = items.filter((order) => order.status === filter.value);
    if (visible.length) return visible.map((order) => orderCard(order, () => onOpen(order.id)));
    return filter.value === "active"
      ? [emptyState("Нет активных заказов", "Создайте заказ, чтобы сохранить договорённости с заказчиком.")]
      : [emptyState("Нет завершённых заказов", "Здесь появятся заказы, которые вы завершите.")];
  }, space.md);

  return orders.bind(page("orders", pageBody(heading, filters, list), {
    action: primaryButton("Новый заказ", "new-order", onCreate, assetIcon("lucide:plus")),
    onBack,
  }));
}
