import { colors, radius, space, type } from "./theme";
import { bindKeyboardScroll } from "./form-focus";

const contentWidth = 520;

export const cardStyle = {
  backgroundColor: colors.surface,
  borderColor: colors.border,
  borderWidth: 1,
  borderRadius: radius.card,
};

export function icon(source: SvgSource, color: string, size = 20) {
  return UIImage(source).style({ width: size, height: size, tintColor: color, flexShrink: 0 });
}

export function iconTile(source: SvgSource) {
  return UIBox(icon(source, colors.accentInk)).style({
    width: 42,
    height: 42,
    flexShrink: 0,
    backgroundColor: colors.aiStrong,
    borderRadius: radius.control,
  });
}

export function pageTitle(title: string | (() => string)) {
  return UIText(title).style(type.page);
}

export function recordTitle(title: string, subtitle?: string) {
  const heading = pageTitle(title);
  const compactTitle = title.length > 90;
  const compactSubtitle = (subtitle?.length ?? 0) > 60;
  const expanded = signal(false);
  if (title.length > 55) heading.style({ fontSize: 24, lineHeight: 31, letterSpacing: -0.5 });
  if (compactTitle) heading.style({ lineClamp: () => expanded.value ? 0 : 4 });
  const caption = subtitle ? hint(subtitle) : null;
  if (compactSubtitle) caption?.style({ lineClamp: () => expanded.value ? 0 : 2 });
  return UIColumn(
    heading,
    caption,
    compactTitle || compactSubtitle ? secondaryButton(
      () => expanded.value ? "Свернуть заголовок" : "Развернуть заголовок",
      "toggle-record-title",
      () => { expanded.value = !expanded.value; },
    ).style({ alignSelf: "flex-start" }) : null,
  ).style({ gap: space.sm });
}

export function recordHeader(heading: UINodeChild, record: "order" | "service", onEdit: () => void, onMenu: () => void) {
  return UIRow(
    UIColumn(heading).style({ flex: 1, minWidth: 0 }),
    UIColumn(
      UIButton(icon(assetIcon("lucide:pencil"), colors.accentInk, 18))
        .style({ ...cardStyle, width: 44, height: 44, borderRadius: radius.control, $pressed: { backgroundColor: colors.ai } })
        .named(`edit-${record}`).onClick(onEdit),
      UIButton(icon(assetIcon("lucide:ellipsis"), colors.text, 20))
        .style({ width: 44, height: 44, borderRadius: radius.control, $pressed: { backgroundColor: colors.control } })
        .named(`${record}-menu`).onClick(onMenu),
    ).style({ gap: space.xs }),
  ).style({ gap: space.md, alignItems: "flex-start" });
}

export function card(...children: UINodeChild[]) {
  return UIColumn(children).style({ ...cardStyle, padding: space.lg, gap: space.xs });
}

export function primaryButton(label: string | (() => string), name: string, onClick: () => void, source?: SvgSource) {
  return UIButton(
    source && icon(source, colors.surface, 18),
    UIText(label).style({ ...type.button, color: colors.surface }),
  ).style({
    minHeight: 48,
    paddingHorizontal: space.lg,
    gap: space.sm,
    borderRadius: radius.control,
    backgroundColor: colors.accent,
    $pressed: { backgroundColor: colors.accentPressed },
  }).named(name).onClick(onClick);
}

export function secondaryButton(label: string | (() => string), name: string, onClick: () => void, danger = false) {
  return UIButton(UIText(label).style({ ...type.button, color: danger ? colors.danger : colors.accentInk, flexShrink: 1, minWidth: 0, textAlign: "center" }))
    .style({
      ...cardStyle, minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.control,
      $pressed: { backgroundColor: danger ? colors.dangerSurface : colors.ai },
    }).named(name).onClick(onClick);
}

export function arrow() {
  return icon(assetIcon("lucide:chevron-right"), colors.textMuted, 18);
}

export function hint(text: string | (() => string)) {
  return UIText(text).style({ ...type.body, color: colors.textMuted });
}

export function aiNote(title: string, description: string) {
  return UIRow(
    iconTile(assetIcon("lucide:sparkles")),
    UIColumn(UIText(title).style({ ...type.card, color: colors.accentInk }), hint(description))
      .style({ flex: 1, minWidth: 0, gap: space.xs }),
  ).style({ ...cardStyle, backgroundColor: colors.ai, borderColor: colors.aiStrong, padding: space.lg, gap: space.md });
}

export function emptyState(title: string, description: string) {
  return card(UIText(title).style(type.card), hint(description)).style({ padding: space.xl, gap: space.sm });
}

export function dialog(...children: UINodeChild[]) {
  return UIModal(children).style({
    ...cardStyle, width: "calc(100% - 40px)", maxWidth: 420, padding: space.xl, gap: space.md,
    overlayColor: "rgba(17,24,39,.38)",
  });
}

export function actionMenu(title: string, closeName: string, contents: UINodeChild, canClose = () => true) {
  const close = () => { if (canClose()) modal.hide(); };
  const modal = dialog(
    UIRow(
      UIText(title).style({ ...type.card, flex: 1, minWidth: 0 }),
      UIButton(icon(assetIcon("lucide:x"), colors.textMuted, 18)).style({
        width: 40, height: 40, borderRadius: radius.control, $pressed: { backgroundColor: colors.control },
      }).named(closeName).onClick(close),
    ).style({ alignItems: "center", gap: space.sm }),
    UIScrollable(contents).style({ flexShrink: 1, minHeight: 0 }),
  ).style({ gap: space.sm, maxHeight: "85%" });
  return modal.onDismiss(close);
}

export function menuAction(label: string | (() => string), name: string, source: SvgSource, onClick: () => void, danger = false) {
  const color = danger ? colors.danger : colors.text;
  return UIButton(icon(source, color, 18), UIText(label).style({ ...type.label, color, flex: 1, minWidth: 0 }))
    .style({
      ...cardStyle, borderColor: "#DFE2EA", borderRadius: radius.control, minHeight: 46,
      paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.md,
      boxShadow: "0 1px 2px rgba(17,24,39,.04)",
      $pressed: { backgroundColor: danger ? colors.dangerSurface : colors.bg },
    }).named(name).onClick(onClick);
}

export function aiAction(title: string, description: string, name: string, source: SvgSource, onClick: () => void) {
  return UIButton(
    iconTile(source),
    UIColumn(UIText(title).style({ ...type.card, color: colors.accentInk }), hint(description))
      .style({ flex: 1, minWidth: 0, gap: space.xs }),
    arrow(),
  ).style({
    ...cardStyle, backgroundColor: colors.ai, borderColor: colors.aiStrong, padding: space.lg, gap: space.md,
    $pressed: { backgroundColor: colors.aiStrong },
  }).named(name).onClick(onClick);
}

export function wordmark(fontSize = 24) {
  return UIText("scope", UIText(".").style({ color: colors.accent }), "diff").style({
    fontSize, lineHeight: fontSize + 6, fontWeight: 800, letterSpacing: -0.9,
  });
}

function header(onBack?: () => void) {
  const back = onBack && UIButton(
    icon(assetIcon("lucide:arrow-left"), colors.text, 18),
    UIText("Назад").style(type.label),
  )
    .style({
      position: "absolute",
      left: "max(safe-left, 12px)",
      top: 6,
      height: 44,
      paddingHorizontal: space.sm,
      gap: space.xs,
      borderRadius: radius.control,
      $pressed: { backgroundColor: colors.control },
    })
    .named("back")
    .onClick(onBack);

  return UIColumn(
    UIBox(
      wordmark().named("wordmark"),
      back,
    ).style({ width: "100%", maxWidth: contentWidth, height: 56, alignSelf: "center" }),
  ).style({
    paddingTop: "safe-top",
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  });
}

export function pageBody(...children: UINodeChild[]) {
  return UIScrollable(
    UIColumn(children).style({
      width: "100%",
      maxWidth: contentWidth,
      alignSelf: "center",
      gap: space.lg,
      paddingTop: space.xxl,
      paddingBottom: "max(safe-bottom, 16px)",
    }),
  ).style({ flex: 1, minHeight: 0, paddingHorizontal: "comfort-x" }).named("page-scroll");
}

export function page(name: string, body: UIScrollable, options: {
  action?: UIButton;
  actionVisible?: () => boolean;
  feedback?: UIText;
  onBack?: () => void;
} = {}) {
  const footer = options.action && UIColumn(
    UIColumn(options.feedback, options.action).style({
      width: "100%", maxWidth: contentWidth, alignSelf: "center", gap: space.sm,
    }),
  ).style({
    flexShrink: 0,
    paddingTop: space.sm,
    paddingBottom: "max(safe-bottom, 12px)",
    paddingHorizontal: "comfort-x",
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    display: () => options.actionVisible?.() === false ? "none" : "flex",
  });

  const screen = UIScreen(header(options.onBack), body, footer)
    .style({ backgroundColor: colors.bg })
    .named(name);
  bindKeyboardScroll(screen, body);
  return options.onBack ? screen.onBack(options.onBack) : screen;
}
