import { api, errorMessage } from "../api/client";
import { card, hint, secondaryButton } from "./components";
import { colors, radius, space, type } from "./theme";

type LoadState<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

export function resource<T>(read: () => Promise<T>) {
  const state = signal<LoadState<T>>({ status: "loading" });
  const loading = signal(false);
  let request = 0;
  let renderedData: string | undefined;

  async function load() {
    const expected = ++request;
    loading.value = true;
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
    } finally {
      if (expected === request) loading.value = false;
    }
  }

  async function refresh() {
    if (loading.value) return;
    api.allowInitialSessionRetry?.();
    await load();
  }

  return {
    state,
    loading,
    load,
    refresh,
    bind(screen: UIScreen, refreshOnResume = false) {
      const resume = () => { if (!loading.value) void load(); };
      return screen.onOpen(() => {
        if (refreshOnResume) app.addEventListener("resume", resume);
        void load();
      }).onClose(() => {
        if (refreshOnResume) app.removeEventListener("resume", resume);
        request++;
        loading.value = false;
      });
    },
    view(render: (data: T) => UINodeChild[], gap = space.lg) {
      return UIColumn(() => {
        const current = state.value;
        switch (current.status) {
          case "ready": return render(current.data);
          case "loading": return [card(hint("Загрузка…"))];
          case "error": return [card(hint(current.message), secondaryButton("Повторить", "retry", refresh))];
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
