import type { Place } from "./qloo/api.ts";

const KEEP =
  /restaurant|cafe|coffee|tea|bakery|patisserie|dessert|ice_cream|(^|_)bar$|pub|brewery|winery|wine|book_store|comic|record|vintage|thrift|second_hand|boutique|clothing|flea_market|market|museum|gallery|art_center|live_music|theater|cinema|night_club|park|garden|spice|deli/;

const isTasteVenue = (p: Place) => {
  const genre = p.genre.replace("urn:tag:genre:place:", "");
  return KEEP.test(genre) || (genre === "event_venue" && p.categories.includes("Live music venue"));
};

export function curatePlaces(places: Place[], limit = 8, maxPerGenre = 2): Place[] {
  const perGenre = new Map<string, number>();
  return places
    .filter((p) => !p.closed && isTasteVenue(p))
    .sort((a, b) => b.affinity - a.affinity)
    .filter((p) => {
      const n = perGenre.get(p.genre) ?? 0;
      perGenre.set(p.genre, n + 1);
      return n < maxPerGenre;
    })
    .slice(0, limit);
}
