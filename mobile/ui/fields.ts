import { formatDate } from "../proposals/model";
import { cardStyle, icon } from "./components";
import { trackFormFocus } from "./form-focus";
import { colors, radius, space, type } from "./theme";

const fieldStyle = {
  ...cardStyle, ...type.body, minHeight: 48, padding: space.md, borderRadius: radius.control,
  placeholderColor: colors.textMuted, $focused: { borderColor: colors.accent },
};

export function fieldLabel(label: string, required = false) {
  return UIText(label, required ? UIText(" *").style({ color: colors.danger }) : "").style(type.label);
}

export function field(label: string, input: UIInput | UITextArea, required = false) {
  trackFormFocus(input);
  return UIColumn(fieldLabel(label, required), input).style({ gap: space.sm });
}

export function textInput(name: string, placeholder: string, value: string, maxLength: number) {
  const input = UIInput().style({ ...fieldStyle, placeholder, maxLength }).named(name);
  input.value = value;
  return input;
}

export function textArea(name: string, placeholder: string, value: string, maxLength = 12000, minHeight = 96) {
  const input = UITextArea().style({ ...fieldStyle, placeholder, maxLength, minHeight, maxHeight: 220 }).named(name);
  input.value = value;
  return input;
}

export function dateField(label: string, name: string, clearName: string, initial: string | null) {
  const selected = signal(initial ?? "");
  const focused = signal(false);
  const input = UIInput().style({
    ...fieldStyle, type: "date", color: "transparent", placeholderColor: "transparent",
    borderWidth: 0, backgroundColor: "transparent",
  })
    .named(name).onChange((value) => { selected.value = value; });
  input.value = selected.value;
  trackFormFocus(input, (value) => { focused.value = value; });
  const clear = UIButton(icon(assetIcon("lucide:x"), colors.textMuted, 16)).style({
    width: 44, height: 44, borderRadius: radius.control, flexShrink: 0,
    display: () => selected.value ? "flex" : "none", $pressed: { backgroundColor: colors.control },
  }).named(clearName).onClick(() => {
    input.blur();
    input.value = "";
    selected.value = "";
  });
  const display = UIRow(
    UIText(() => selected.value ? formatDate(selected.value) : "Выбрать дату").style({
      ...type.body, color: () => selected.value ? colors.text : colors.textMuted, pointerEvents: "none",
    }).named(`${name}-display`),
    icon(assetIcon("lucide:calendar-days"), colors.textMuted, 16)
      .style({ display: () => focused.value ? "none" : "flex" }),
  ).style({
    position: "absolute", left: space.md, right: space.md, top: 0, bottom: 0,
    alignItems: "center", justifyContent: "space-between", pointerEvents: "none",
  });
  return {
    node: UIColumn(fieldLabel(label), UIRow(
      UIColumn(input, display).style({ position: "relative", flex: 1, minWidth: 0 }),
      clear,
    ).style({
      ...cardStyle, borderRadius: radius.control, alignItems: "center",
      borderColor: () => focused.value ? colors.accent : colors.border,
    })).style({ gap: space.sm }),
    value: () => input.value || null,
  };
}
