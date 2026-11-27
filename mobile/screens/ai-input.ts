import type { ID, Service } from "../../shared/types";
import { api, type AiInput } from "../api/client";
import { aiExamples } from "../api/mock-ai";
import { errorNotice, mutation } from "../ui/async";
import { aiNote, hint, page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { field, textArea } from "../ui/fields";
import { servicePicker } from "../ui/service-picker";
import { colors, space, type } from "../ui/theme";

type AiScreenOptions<T> = {
  entity: "service" | "order" | "changes";
  mode: "voice" | "screenshots" | "text";
  title: string;
  button: string;
  preset?: Service;
  submit: (input: AiInput, serviceId?: ID) => Promise<T>;
  onSaved: (result: T) => void;
};

export function aiInputScreen<T>(options: AiScreenOptions<T>) {
  const save = mutation();
  const example = aiExamples[options.entity];
  const text = textArea("ai-text", options.entity === "changes" ? "Опишите новые пожелания" : "Введите описание", "");
  const picker = options.entity === "order" ? servicePicker(options.preset ?? null) : null;
  const screenshots = signal<File[]>([]);
  const picking = signal(false);
  const recording = signal(false);
  const starting = signal(false);
  const inputError = signal("");
  const speech = options.mode === "voice" && SpeechRecognizer.supported ? new SpeechRecognizer() : null;
  let visible = false;
  let prefix = "";

  speech?.addEventListener("result", ({ transcript }) => {
    if (visible) text.value = `${prefix}${transcript}`.slice(0, 12000);
  });
  speech?.addEventListener("end", () => { recording.value = false; });
  speech?.addEventListener("error", (code) => {
    if (!visible || code === "aborted") return;
    inputError.value = code === "noSpeech"
      ? "Речь не распознана. Попробуйте снова или введите текст."
      : "Распознавание недоступно. Введите текст вручную.";
  });

  async function toggleSpeech() {
    if (!speech || starting.value || save.pending.value) return;
    if (recording.value) {
      speech.stop();
      return;
    }
    inputError.value = "";
    text.blur();
    prefix = text.value.trim() ? `${text.value.trim()}\n` : "";
    starting.value = true;
    try {
      await speech.start({ language: "ru-RU" });
      if (visible) recording.value = speech.listening;
      else speech.abort();
    } catch {
      if (visible && !inputError.value) inputError.value = "Не удалось запустить распознавание. Введите текст вручную.";
    } finally {
      starting.value = false;
    }
  }

  async function pickScreenshots() {
    if (picking.value || save.pending.value) return;
    inputError.value = "";
    picking.value = true;
    try {
      const files = await openFilePicker({ accept: "image/png,image/jpeg,image/webp", multiple: true });
      if (visible && files.length) screenshots.value = files;
    } catch {
      if (visible) inputError.value = "Не удалось открыть выбор файлов. Попробуйте снова.";
    } finally {
      picking.value = false;
    }
  }

  const voiceInput = options.mode === "voice" && (speech
    ? secondaryButton(() => {
      if (starting.value) return "Включаем микрофон…";
      return recording.value ? "Остановить запись" : "Диктовать";
    }, "dictate", () => { void toggleSpeech(); })
    : hint("В этом режиме распознавание речи недоступно. Введите текст вручную."));

  const fileInput = options.mode !== "voice" && UIColumn(
    secondaryButton(() => picking.value ? "Открываем выбор…" : screenshots.value.length ? "Заменить скриншоты" : "Выбрать скриншоты",
      "pick-screenshots", () => { void pickScreenshots(); }),
    UIColumn(() => screenshots.value.map((file) => hint(file.name))).style({ gap: space.xs }),
    secondaryButton("Убрать скриншоты", "clear-screenshots", () => { screenshots.value = []; })
      .style({ display: () => screenshots.value.length ? "flex" : "none" }),
    UIText("До 3 изображений PNG, JPEG или WebP, каждое до 5 МБ.").style({ ...type.small, color: colors.textMuted }),
  ).style({ gap: space.sm });

  function submit() {
    if (picking.value || recording.value || starting.value) return;
    inputError.value = "";
    const input = { text: text.value, files: screenshots.value };
    const serviceId = picker?.selected.value?.id ?? undefined;
    void save.run(() => options.submit(input, serviceId), options.onSaved);
  }

  const screen = page(options.entity === "changes" ? "change-input" : `import-${options.entity}-${options.mode}`, pageBody(
    pageTitle(options.title),
    api.demo && aiNote("Демонстрационный режим", options.mode === "voice"
      ? "Текст обрабатывается локально. Микрофон использует распознавание вашего устройства или браузера."
      : options.mode === "screenshots"
        ? "Для скриншотов используются готовые примеры. Выбранные изображения остаются на устройстве."
        : "Текст обрабатывается локально. Перечислите пожелания с новой строки."),
    picker && UIColumn(UIText("Услуга · необязательно").style(type.label), picker.control).style({ gap: space.sm }),
    voiceInput,
    fileInput,
    field(options.mode === "screenshots" ? "Текст к скриншотам · необязательно" : "Текст", text),
    api.demo && secondaryButton("Заполнить пример", "ai-example", () => { if (!recording.value && !starting.value && !save.pending.value) text.value = example; }),
  ), {
    feedback: errorNotice(() => inputError.value || save.error.value),
    onBack: () => { if (!save.pending.value) Router.pop(); },
    action: primaryButton(() => save.pending.value ? "Сохраняем…" : options.button, "submit-ai", submit, assetIcon("lucide:sparkles")),
  });

  if (picker) screen.widgets(picker.modal);
  return screen.onOpen(() => { visible = true; }).onClose(() => {
    visible = false;
    speech?.abort();
    recording.value = false;
  });
}
