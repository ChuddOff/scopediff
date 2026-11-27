import type { AiInput } from "./client";

const maxFileSize = 5 * 1024 * 1024;

export function validateAiInput(input: AiInput) {
  const text = input.text?.trim() ?? "";
  const files = input.files ?? [];
  if (!text && !files.length) {
    throw { status: 400, error: { code: "BAD_INPUT", message: "Добавьте текст или хотя бы один скриншот." } };
  }
  if (files.length > 3 || files.some((file) => file.size > maxFileSize)) {
    throw { status: 413, error: { code: "FILE_TOO_LARGE", message: "Можно добавить до трёх скриншотов, каждый до 5 МБ." } };
  }
  // The picker only exposes the file name and size. FastAPI checks the actual media type.
  if (files.some((file) => !/\.(png|jpe?g|webp)$/i.test(file.name) || !Number.isFinite(file.size) || file.size <= 0)) {
    throw { status: 400, error: { code: "BAD_INPUT", message: "Выберите изображения в формате PNG, JPEG или WebP." } };
  }
  return { text, files };
}
