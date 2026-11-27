import { cardStyle } from "./components";
import { colors, radius, space, type } from "./theme";

const fieldStyle = {
  ...cardStyle, ...type.body, minHeight: 48, padding: space.md, borderRadius: radius.control,
  placeholderColor: colors.textMuted, $focused: { borderColor: colors.accent },
};

export function field(label: string, input: UIInput | UITextArea) {
  return UIColumn(UIText(label).style(type.label), input).style({ gap: space.sm });
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

export function dateInput(name: string, value: string) {
  const input = UIInput().style({ ...fieldStyle, type: "date", placeholder: "Выберите дату" }).named(name);
  input.value = value;
  return input;
}
