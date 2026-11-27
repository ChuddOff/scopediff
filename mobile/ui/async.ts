import { errorMessage } from "../api/client";
import { card, hint, secondaryButton } from "./components";
import { colors, radius, space, type } from "./theme";

type LoadState<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

export function resource<T>(read: () => Promise<T>) {
  const state = signal<LoadState<T>>({ status: "loading" });
  let request = 0;
  let renderedData: string | undefined;

  async function load() {
    const expected = ++request;
    if (state.value.status !== "ready") state.value = { status: "loading" };
    try {
      const data = await read();
      if (expected !== request) return;
      const fingerprint = JSON.stringify(data);
      if (state.value.status !== "ready" || renderedData !== fingerprint) {
        renderedData = fingerprint;
        state.value = { status: "ready", data };
      }
    } catch (error) {
      if (expected === request) state.value = { status: "error", message: errorMessage(error) };
    }
  }

  return {
    state,
    load,
    bind(screen: UIScreen) {
      return screen.onOpen(load).onClose(() => { request++; });
    },
    view(render: (data: T) => UINodeChild[], gap = space.lg) {
      return UIColumn(() => {
        const current = state.value;
        switch (current.status) {
          case "ready": return render(current.data);
          case "loading": return [card(hint("Загрузка…"))];
          case "error": return [card(hint(current.message), secondaryButton("Повторить", "retry", load))];
        }
      }).style({ gap });
    },
  };
}

export function mutation() {
  const pending = signal(false);
  const error = signal("");

  async function run<T>(write: () => Promise<T>, onSuccess?: (result: T) => void, onFailure?: (error: unknown) => void) {
    if (pending.value) return;
    pending.value = true;
    error.value = "";
    let result: T;
    try {
      result = await write();
    } catch (failure) {
      error.value = errorMessage(failure);
      onFailure?.(failure);
      return;
    } finally {
      pending.value = false;
    }
    onSuccess?.(result);
  }

  return { pending, error, run };
}

export function errorNotice(error: Signal<string> | (() => string)) {
  const message = typeof error === "function" ? error : () => error.value;
  return UIText(message).style({
    ...type.small, padding: space.md, borderRadius: radius.control,
    color: colors.danger, backgroundColor: colors.dangerSurface,
    display: () => message() ? "flex" : "none",
  }).named("error-notice");
}
