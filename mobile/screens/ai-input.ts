import type { ID, Service } from "../../shared/types";
import { api, isConflict, isOutcomeUnknown, type AiInput } from "../api/client";
import { errorNotice, mutation } from "../ui/async";
import { aiNote, cardStyle, hint, icon, iconTile, page, pageBody, pageTitle, primaryButton, secondaryButton } from "../ui/components";
import { dictationField } from "../ui/dictation-field";
import { field, fieldLabel, textArea } from "../ui/fields";
import { servicePicker } from "../ui/service-picker";
import { speechCapture } from "../ui/speech";
import { colors, radius, space, type } from "../ui/theme";

export type AiMode = "voice" | "screenshots" | "text";
type AiScreenOptions<T> = {
  entity: "service" | "order" | "changes";
  mode: AiMode;
  title: string;
  button: string;
  preset?: Service;
  context?: string;
  submit: (input: AiInput, serviceId?: ID) => Promise<T>;
  onSaved: (result: T) => void;
  onReview?: () => Promise<void> | void;
};

export function aiInputScreen<T>(options: AiScreenOptions<T>) {
  const save = mutation();
  const review = mutation();
  const needsReview = signal(false);
  const example = api.demoExamples?.[options.entity];
  const picker = options.entity === "order" ? servicePicker(options.preset ?? null) : null;
  const screenshots = signal<File[]>([]);
  const picking = signal(false);
  const inputError = signal("");
  const showVoiceText = signal(!SpeechRecognizer.supported);
  const voiceText = options.mode === "voice" ? textArea("ai-text", "Опишите пожелания или вставьте переписку", "") : null;
  const written = options.mode === "voice" ? null : dictationField(
    "ai-text", options.mode === "screenshots" ? "Комментарий" : "Пожелания",
    options.mode === "screenshots" ? "Что важно учесть в переписке" : "Вставьте переписку или опишите, что нужно изменить", "",
    {
      kind: options.entity === "changes" ? "change_item" : options.entity,
      title: () => options.title,
      context: () => {
        const service = picker?.selected.value;
        return [options.context, service ? `Услуга: ${service.name}. ${service.description}` : ""].filter(Boolean).join("\n");
      },
      minHeight: options.mode === "text" ? 180 : 82,
    },
  );
  const text = voiceText ?? written!.input;
  let visible = false;
  const speech = speechCapture((transcript) => {
    text.value = [text.value.trim(), transcript].filter(Boolean).join("\n").slice(0, 12000);
    showVoiceText.value = true;
  }, (error) => {
    inputError.value = error;
    showVoiceText.value = true;
  });

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

  const voiceStatus = () => {
    switch (speech.state.value) {
      case "starting": return "Включаем микрофон…";
      case "recording": return "Идёт запись · нажмите, чтобы остановить";
      case "stopping": return "Завершаем запись…";
      default: return "Нажмите, чтобы начать запись";
    }
  };
  const voiceInput = voiceText && UIColumn(
    SpeechRecognizer.supported ? UIColumn(
      UIButton(UIColumn(() => [icon(speech.state.value === "recording" ? assetIcon("lucide:square") : assetIcon("lucide:mic"), colors.accentInk, 34)]))
        .style({ width: 82, height: 82, borderRadius: 24, backgroundColor: colors.ai, $pressed: { backgroundColor: colors.aiStrong } })
        .named("dictate").onClick(() => {
          if (save.pending.value) return;
          inputError.value = "";
          text.blur();
          void speech.toggle();
        }),
      UIText(voiceStatus).style({ ...type.label, textAlign: "center", color: colors.textMuted }),
    ).style({ alignItems: "center", gap: space.md, paddingVertical: space.xl }) : hint("Распознавание речи недоступно. Введите текст вручную."),
    field("Текст", voiceText).style({ display: () => showVoiceText.value ? "flex" : "none" }),
    SpeechRecognizer.supported ? secondaryButton("Ввести текст", "voice-use-text", () => { showVoiceText.value = true; })
      .style({ display: () => showVoiceText.value || speech.state.value !== "idle" ? "none" : "flex" }) : null,
  ).style({ gap: space.sm });

  const fileInput = options.mode === "screenshots" && UIColumn(
    UIButton(
      iconTile(assetIcon("lucide:images")),
      UIText(() => picking.value ? "Открываем выбор…" : screenshots.value.length ? "Заменить скриншоты" : "Выбрать скриншоты")
        .style({ ...type.card, color: colors.accentInk, textAlign: "center" }),
      UIText("До 3 изображений PNG, JPEG или WebP, каждое до 5 МБ.").style({ ...type.small, color: colors.textMuted, textAlign: "center" }),
    ).style({
      ...cardStyle, flexDirection: "column", minHeight: 132, gap: space.sm, padding: space.lg,
      $pressed: { backgroundColor: colors.ai },
    }).named("pick-screenshots").onClick(() => { void pickScreenshots(); }),
    UIColumn(() => screenshots.value.map((file, index) => UIRow(
      UIImage(file).style({ width: 44, height: 44, borderRadius: space.sm, objectFit: "cover", flexShrink: 0 }),
      UIText(file.name).style({ ...type.small, flex: 1, minWidth: 0, lineClamp: 2 }),
      UIButton(icon(assetIcon("lucide:x"), colors.textMuted, 16))
        .style({ width: 44, height: 44, borderRadius: radius.control, $pressed: { backgroundColor: colors.control } })
        .named(`remove-screenshot-${index + 1}`).onClick(() => {
          if (save.pending.value) return;
          screenshots.value = screenshots.value.filter((_, position) => position !== index);
        }),
    ).style({ ...cardStyle, padding: space.sm, gap: space.sm, alignItems: "center" }))).style({ gap: space.sm }),
  ).style({ gap: space.sm });

  function submit() {
    if (picking.value || speech.state.value !== "idle" || written?.busy() || review.pending.value) return;
    if (needsReview.value && options.onReview) {
      void review.run(async () => options.onReview?.(), () => { needsReview.value = false; });
      return;
    }
    inputError.value = "";
    const input = { text: text.value, files: screenshots.value };
    const serviceId = picker?.selected.value?.id ?? undefined;
    void save.run(() => options.submit(input, serviceId), options.onSaved, (error) => {
      needsReview.value = Boolean(options.onReview) && (isConflict(error) || isOutcomeUnknown(error));
    });
  }

  const screen = page(options.entity === "changes" ? "change-input" : `import-${options.entity}-${options.mode}`, pageBody(
    pageTitle(options.title),
    picker && UIColumn(fieldLabel("Услуга"), picker.control).style({ gap: space.sm }),
    voiceInput,
    fileInput,
    written?.node,
    api.demo ? aiNote("Демонстрационный режим", options.mode === "screenshots"
      ? "Для скриншотов используются готовые примеры. Изображения остаются на устройстве."
      : "Текст обрабатывается локально. Перечислите пожелания с новой строки.")
      : aiNote(options.mode === "text" ? "Помогите AI понять пожелания" : "Перед отправкой в AI",
        "Оставьте только нужные фрагменты и уберите личные данные. Материалы будут переданы для обработки AI."),
    example ? secondaryButton("Заполнить пример", "ai-example", () => {
      if (speech.state.value !== "idle" || written?.busy() || save.pending.value) return;
      text.value = example;
      showVoiceText.value = true;
    }) : null,
  ), {
    feedback: errorNotice(() => inputError.value || review.error.value || save.error.value),
    onBack: () => { if (!save.pending.value && !review.pending.value) Router.pop(); },
    action: primaryButton(() => {
      if (save.pending.value) return api.demo ? "Обрабатываем…" : "Обрабатываем с AI…";
      if (review.pending.value) return "Обновляем данные…";
      return needsReview.value ? "Проверить данные" : options.button;
    }, "submit-ai", submit, assetIcon("lucide:sparkles")),
  });
  if (picker) screen.widgets(picker.modal);
  return screen.onOpen(() => { visible = true; }).onClose(() => {
    visible = false;
    speech.cancel();
    written?.cancel();
  });
}
