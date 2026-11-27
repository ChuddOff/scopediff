import { errorNotice, mutation } from "./async";
import { isConflict, isOutcomeUnknown } from "../api/client";
import { dialog, hint, secondaryButton } from "./components";
import { type } from "./theme";

export function deleteDialog(title: string, description: string, remove: () => Promise<void>, refresh: () => Promise<void>) {
  const deletion = mutation();
  const modal = dialog(
    UIText(title).style(type.card), hint(description), errorNotice(deletion.error),
    secondaryButton(() => deletion.pending.value ? "Удаляем…" : "Удалить", "confirm-delete", () => {
      void deletion.run(remove, () => { modal.hide(); Router.pop(); }, (error) => {
        if (isConflict(error) || isOutcomeUnknown(error)) void refresh();
      });
    }, true),
    secondaryButton("Отмена", "cancel-delete", () => close()),
  ).onDismiss(() => close());

  function close() {
    if (!deletion.pending.value) modal.hide();
  }

  return { modal, show() { deletion.error.value = ""; modal.show(); } };
}
