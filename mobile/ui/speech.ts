type RecognitionState = "idle" | "starting" | "recording" | "stopping";
export type Recognizer = Pick<SpeechRecognizer, "addEventListener" | "start" | "stop" | "abort">;

export function speechCapture(
  onDictation: (text: string) => void,
  onError: (message: string) => void,
  create = (): Recognizer | null => SpeechRecognizer.supported ? new SpeechRecognizer() : null,
) {
  const state = signal<RecognitionState>("idle");
  let active: Recognizer | null = null;

  async function toggle() {
    if (state.value === "recording") {
      state.value = "stopping";
      active?.stop();
      return;
    }
    if (state.value !== "idle") return;
    const speech = create();
    if (!speech) {
      onError("Распознавание речи недоступно. Введите текст вручную.");
      return;
    }
    let result = "";
    let failed = false;
    active = speech;
    state.value = "starting";
    const fail = (code: string) => {
      if (active !== speech || failed) return;
      failed = true;
      onError(code === "noSpeech"
        ? "Речь не распознана. Попробуйте ещё раз или введите текст."
        : "Не удалось распознать речь. Введите текст вручную или повторите попытку.");
    };
    speech.addEventListener("result", ({ transcript, isFinal }) => {
      if (active === speech && isFinal && transcript.trim()) result = transcript.trim();
    });
    speech.addEventListener("error", fail);
    speech.addEventListener("end", () => {
      if (active !== speech) return;
      if (!failed && !result) fail("noSpeech");
      active = null;
      state.value = "idle";
      if (!failed) onDictation(result);
    });
    try {
      await speech.start({ language: "ru-RU", continuous: false, interimResults: true });
      if (active === speech && state.value === "starting") state.value = "recording";
      else if (active !== speech) speech.abort();
    } catch (error) {
      if (active !== speech) return;
      fail(typeof error === "string" ? error : "unavailable");
      active = null;
      state.value = "idle";
      speech.abort();
    }
  }

  return {
    state,
    toggle,
    cancel() {
      const speech = active;
      active = null;
      state.value = "idle";
      speech?.abort();
    },
  };
}
