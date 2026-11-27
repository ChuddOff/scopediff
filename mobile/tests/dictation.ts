import { configureApi } from "../api/client";
import { mockApi } from "../api/mock";
import { page, pageBody, secondaryButton } from "../ui/components";
import { dictationField } from "../ui/dictation-field";
import type { Recognizer } from "../ui/speech";

function fakeRecognizer(): Recognizer {
  const listeners: Partial<SpeechRecognizerEvents> = {};
  return {
    addEventListener(channel, callback) { listeners[channel] = callback; },
    async start(options) {
      if (options?.language !== "ru-RU") throw new Error("Expected Russian speech");
    },
    stop() {
      listeners.result?.({ transcript: "новый абзац", isFinal: true, confidence: null });
      listeners.end?.();
    },
    abort() { listeners.end?.(); },
  };
}

const attempts = signal(0);
let releaseResponse: (() => void) | undefined;
const localEnhance = mockApi.enhanceDescription;
configureApi({
  ...mockApi,
  async enhanceDescription(input) {
    if (input.kind !== "change_item" || input.title !== "Правка" || input.context !== "Описание заказа" ||
      input.currentText !== "Исходный текст." || input.dictation !== "новый абзац") {
      throw { error: { message: "Некорректный контекст запроса." } };
    }
    attempts.value++;
    if (attempts.value === 2) throw { error: { message: "Тестовый сбой обработки." } };
    if (attempts.value === 3) await new Promise<void>((resolve) => { releaseResponse = resolve; });
    return localEnhance(input);
  },
});

const example = dictationField("test-description", "Описание", "Текст", "Исходный текст.", {
  kind: "change_item", title: () => "Правка", context: () => "Описание заказа",
}, fakeRecognizer);
page("dictation-test", pageBody(
  example.node,
  secondaryButton("Завершить тестовый запрос", "finish-request", () => releaseResponse?.()),
  UIText(() => `Запросов: ${attempts.value}`),
)).open();
