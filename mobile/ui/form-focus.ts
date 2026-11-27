type FormInput = UIInput | UITextArea;

let focused: { input: FormInput; anchor: FormInput | UIColumn } | undefined;
let activeViewport: UIScrollable | undefined;

function revealFocusedField() {
  const fieldFocus = focused;
  const viewport = activeViewport;
  if (!fieldFocus || !viewport || app.keyboardHeight <= 0) return;
  const field = fieldFocus.anchor.getBoundingClientRect();
  const area = viewport.getBoundingClientRect();
  if (!field || !area) return;

  const margin = 8;
  const above = field.top < area.top + margin;
  const below = field.bottom > area.bottom - margin;
  if (!above && !below) return;

  const align = above || field.height + margin * 2 > area.height ? "start" : "end";
  viewport.scrollToElement(fieldFocus.anchor, { align, offset: margin, animated: false });
}

export function trackFormFocus(input: FormInput, onChange?: (focused: boolean) => void, anchor: FormInput | UIColumn = input) {
  input.onFocus(() => {
    focused = { input, anchor };
    onChange?.(true);
    revealFocusedField();
  }).onBlur(() => {
    if (focused?.input === input) focused = undefined;
    onChange?.(false);
  });
}

export function bindKeyboardScroll(screen: UIScreen, viewport: UIScrollable) {
  viewport.onLayout(() => { if (activeViewport === viewport) revealFocusedField(); });
  screen.onOpen(() => {
    activeViewport = viewport;
    app.addEventListener("keyboard", revealFocusedField);
  });
  screen.onClose(() => {
    if (activeViewport !== viewport) return;
    activeViewport = undefined;
    focused = undefined;
    app.removeEventListener("keyboard", revealFocusedField);
  });
}
