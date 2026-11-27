import { newOrder, newService, openOrder, openService } from "./navigation";
import { ordersScreen } from "./screens/orders";
import { servicesScreen } from "./screens/services";

const tabs = UITabs({
  orders: {
    label: "Заказы",
    icon: assetIcon("lucide:briefcase-business"),
    screen: ordersScreen(newOrder, openOrder),
  },
  services: {
    label: "Услуги",
    icon: assetIcon("lucide:layers"),
    screen: servicesScreen(newService, openService),
  },
}).named("scope-diff");

Router.init(tabs, { showDefaultBackButton: false });
