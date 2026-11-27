import { api, errorMessage, type EnhanceDescriptionInput } from "../api/client";
import { cardStyle, hint, icon } from "./components";
import { fieldLabel, textArea } from "./fields";
import { trackFormFocus } from "./form-focus";
import { speechCapture, type Recognizer } from "./speech";
import { colors, radius, space, type } from "./theme";

type Options = {
  kind: EnhanceDescriptionInput["kind"];
  title: () => string;
  context: () => string;
  minHeight?: number;
};

export function dictationField(name: string, label: string, placeholder: string, initial: string, options: Options,
  recognizer?: () => Recognizer | null) {
  const input = textArea(name, placeholder, initial, 12000, options.minHeight ?? 92)
    .style({ borderWidth: 0, backgroundColor: "transparent", $focused: { borderColor: "transparent" } });
  const focused = signal(false);
  const pending = signal(false);
  const message = signal("");
  const undo = signal<{ previous: string; applied: string } | null>(null);
  let revision = 0;
  let request = 0;

  async function enhance(dictation: string) {
    if (pending.value) return;
    const currentText = input.value;
    const expectedRevision = revision;
    const attempt = ++request;
    pending.value = true;
    message.value = "";
    try {
      const { text } = await api.enhanceDescription({
        kind: options.kind, title: options.title(), currentText, dictation, context: options.context(),
      });
      if (attempt !== request) return;
      if (revision !== expectedRevision || input.value !== currentText) {
        message.value = "Текст изменился во время обработки. Ваши правки сохранены.";
        return;
      }
      if (text !== currentText) {
        input.value = text;
        undo.value = { previous: currentText, applied: text };
      }
    } catch (error) {
      if (attempt === request) message.value = errorMessage(error);
    } finally {
      if (attempt === request) pending.value = false;
    }
  }

  const speech = speechCapture((value) => { void enhance(value); }, (error) => { message.value = error; }, recognizer);
  const busy = () => pending.value || speech.state.value !== "idle";
  input.onChange(() => { revision++; undo.value = null; });

  const status = () => {
    if (pending.value) return api.demo ? "Демо: обрабатываем диктовку…" : "Обрабатываем с AI…";
    if (speech.state.value === "starting") return "Включаем микрофон…";
    if (speech.state.value === "recording") return "Идёт запись…";
    if (speech.state.value === "stopping") return "Завершаем запись…";
    return message.value;
  };

  const mic = UIButton(UIColumn(() => [
    icon(speech.state.value === "recording" ? assetIcon("lucide:square") : assetIcon("lucide:mic"), colors.accentInk, 16),
  ])).style({
    width: 36, height: 36, borderRadius: radius.control, backgroundColor: colors.ai,
    $pressed: { backgroundColor: colors.aiStrong }, opacity: () => pending.value ? 0.5 : 1,
  }).named(`${name}-mic`).onClick(() => {
    if (pending.value) return;
    message.value = "";
    input.blur();
    void speech.toggle();
  });
  const control = UIColumn(
    input,
    UIRow(
      UIText(status).style({ ...type.small, color: colors.textMuted, flex: 1, minWidth: 0 }),
      mic,
    ).style({ alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, paddingBottom: space.sm }),
  ).style({ ...cardStyle, borderRadius: radius.control, borderColor: () => focused.value ? colors.accent : colors.border });
  trackFormFocus(input, (value) => { focused.value = value; }, control);

  return {
    input,
    busy,
    cancel() {
      speech.cancel();
      request++;
      pending.value = false;
    },
    node: UIColumn(
      fieldLabel(label),
      control,
      UIColumn(() => undo.value ? [
        api.demo ? hint("Демо: текст обработан локально.") : null,
        UIButton(UIText("Отменить изменение AI").style({ ...type.label, color: colors.accentInk }))
          .style({ minHeight: 36, alignSelf: "flex-start" }).named(`${name}-undo`).onClick(() => {
            const change = undo.value;
            if (busy() || !change || input.value !== change.applied) return;
            input.value = change.previous;
            undo.value = null;
            revision++;
            message.value = "";
          }),
      ] : []).style({ gap: space.xs, display: () => undo.value ? "flex" : "none" }),
    ).style({ gap: space.sm }),
  };
}
