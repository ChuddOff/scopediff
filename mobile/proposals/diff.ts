import type { ProposalVersion } from "../../shared/types";

export function compareVersions(before: ProposalVersion, after: ProposalVersion) {
  const prior = new Map(before.items.map((item) => [item.id, item]));
  const next = new Map(after.items.map((item) => [item.id, item]));
  const added = after.items.filter((item) => !prior.has(item.id));
  const removed = before.items.filter((item) => !next.has(item.id));
  const changed = after.items.flatMap((item) => {
    const previous = prior.get(item.id);
    if (!previous || (previous.title === item.title && previous.description === item.description &&
      previous.price === item.price && previous.category === item.category)) return [];
    return [{ before: previous, after: item }];
  });
  return {
    added, removed, changed,
    deadline: before.deadline !== after.deadline,
    conditions: before.conditions !== after.conditions,
    title: before.title !== after.title,
    comment: before.comment !== after.comment,
  };
}
