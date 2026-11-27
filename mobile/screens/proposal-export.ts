import { card, hint, page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { colors, space, type } from "../ui/theme";

export function textExport(markdown: string, plain: string) {
  const format = signal<"markdown" | "plain">("markdown");
  const email = `mailto:?subject=${encodeURIComponent("Предложение по изменениям")}&body=${encodeURIComponent(plain)}`;
  return page("proposal-export", pageBody(
    pageTitle("Текст для отправки"),
    UIRow(
      secondaryButton("Markdown", "export-markdown-view", () => { format.value = "markdown"; }).style({
        flex: 1, backgroundColor: () => format.value === "markdown" ? colors.ai : colors.surface,
      }),
      secondaryButton("Обычный текст", "export-plain-view", () => { format.value = "plain"; }).style({
        flex: 1, backgroundColor: () => format.value === "plain" ? colors.ai : colors.surface,
      }),
    ).style({ gap: space.sm }),
    card(UIText(() => format.value === "markdown" ? markdown : plain).style(type.body).named("export-content"))
      .style({ gap: space.md }),
    email.length <= 6000 ? secondaryButton("Отправить текст по почте", "export-email", () => openURL(email)) : null,
  ), {
    onBack: () => Router.pop(),
    action: primaryButton(() => format.value === "markdown" ? "Скопировать Markdown" : "Скопировать текст", "copy-export", () => {
      clipboard.write(format.value === "markdown" ? markdown : plain);
      toast("Текст скопирован");
    }, assetIcon("lucide:copy")),
  });
}

export function urlExport(url: string, pdf: boolean) {
  return page("proposal-link", pageBody(
    pageTitle(pdf ? "PDF" : "Интерактивная ссылка"),
    hint(pdf ? "Документ откроется в браузере. Там его можно скачать или переслать." : "Передайте ссылку заказчику, чтобы он мог согласовать условия или предложить изменения."),
    !pdf ? secondaryButton("Скопировать ссылку", "copy-link", () => { clipboard.write(url); toast("Ссылка скопирована"); }) : null,
  ), {
    onBack: () => Router.pop(),
    action: primaryButton("Открыть в браузере", "open-export", () => openURL(url), assetIcon("lucide:external-link")),
  });
}
