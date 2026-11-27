type FormInput = UIInput | UITextArea;

let focused: FormInput | undefined;
let activeViewport: UIScrollable | undefined;

function revealFocusedField() {
  const input = focused;
  const viewport = activeViewport;
  if (!input || !viewport || app.keyboardHeight <= 0) return;
  const field = input.getBoundingClientRect();
  const area = viewport.getBoundingClientRect();
  if (!field || !area) return;

  const margin = 8;
  const above = field.top < area.top + margin;
  const below = field.bottom > area.bottom - margin;
  if (!above && !below) return;

  const align = above || field.height + margin * 2 > area.height ? "start" : "end";
  viewport.scrollToElement(input, { align, offset: margin, animated: false });
}

export function trackFormFocus(input: FormInput) {
  input.onFocus(() => {
    focused = input;
    revealFocusedField();
  }).onBlur(() => { if (focused === input) focused = undefined; });
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
