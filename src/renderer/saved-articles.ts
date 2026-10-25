import type { SavedArticleEntry } from "../shared/browser";

export type SavedArticleSort = "recent" | "oldest" | "title" | "unread";

export const savedArticleSortLabels: Record<SavedArticleSort, string> = {
  recent: "Recently saved",
  oldest: "Oldest saved",
  title: "Title A–Z",
  unread: "Unread first",
};

export function filterAndSortSavedArticles(
  entries: readonly SavedArticleEntry[],
  query: string,
  sort: SavedArticleSort,
): SavedArticleEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries
    .filter((entry) =>
      `${entry.title} ${entry.siteName} ${entry.description ?? ""} ${entry.originalUrl}`
        .toLocaleLowerCase()
        .includes(needle),
    )
    .sort((left, right) => {
      if (sort === "oldest") return left.savedAt - right.savedAt;
      if (sort === "title") return left.title.localeCompare(right.title);
      if (sort === "unread" && left.isRead !== right.isRead) {
        return left.isRead ? 1 : -1;
      }
      return right.savedAt - left.savedAt;
    });
}
