/**
 * "New since you were here": one short line per thing a returning visitor can
 * now do, shown once, a couple per visit.
 *
 * APPEND ONLY. A visitor's record stores how many of these lines they have
 * already been told about, so a new line goes at the end and an old line is
 * never removed or reordered. Someone on their first visit is told nothing:
 * everything is new to them anyway, and the gesture hints are their guide.
 *
 * Write for a person, not for the changelog: name what they can do in a few
 * plain words, then the one key that does it.
 */
export interface NewsItem {
  /** What is new, in a few plain words: "color themes". */
  text: string;
  /** How to try it with a keyboard: "press T". */
  key?: string;
  /** How to try it on a touch screen, when it differs from the keyboard way. */
  touch?: string;
}

export const NEWS: readonly NewsItem[] = [
  { text: "a new world every day", key: "press N", touch: "in the menu" },
  { text: "keep a world you like", key: "press K", touch: "in the menu" },
  { text: "undo a roll of the dice", key: "press backspace", touch: "in the menu" },
  { text: "color themes", key: "press T", touch: "in the menu" },
  { text: "a camera that flies itself", key: "press C", touch: "in the menu" },
  { text: "sound made by the particles", key: "press M", touch: "in the menu" },
];

/** The next lines a visitor who has seen `seen` of them should be told, oldest first. */
export function unseenNews(seen: number, limit = 2, news: readonly NewsItem[] = NEWS): NewsItem[] {
  const from = Math.min(news.length, Math.max(0, Math.floor(seen) || 0));
  return news.slice(from, from + Math.max(0, limit));
}

/** The second line under a news item: how to try it on this kind of device. */
export const newsHint = (item: NewsItem, touch: boolean): string | null =>
  (touch ? item.touch ?? null : item.key ?? null);
