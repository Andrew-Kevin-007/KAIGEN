/**
 * A value for `aria-describedby`: the ids that are actually on the page, space separated, or undefined when there
 * are none. Pass `shown && "the-id"` so an id is listed only while the element it names exists.
 */
export function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length > 0 ? present.join(" ") : undefined;
}
