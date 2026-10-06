import type { Place } from "./qloo/api.ts";

const KEEP =
  /restaurant|cafe|coffee|tea|bakery|patisserie|dessert|ice_cream|(^|_)bar$|pub|brewery|winery|wine|book_store|comic|record|vintage|thrift|second_hand|boutique|clothing|flea_market|market|museum|gallery|art_center|live_music|theater|cinema|night_club|park|garden|spice|deli/;

const EXCLUDE = /adult|strip club|gentlemen'?s club|erotic|sex shop|cannabis|dispensary|vape|smoke shop|casino|gun /i;

const isTasteVenue = (p: Place) => {
  const genre = p.genre.replace("urn:tag:genre:place:", "");
  if (EXCLUDE.test([genre.replaceAll("_", " "), p.name, ...p.categories].join(" | "))) return false;
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

export function placeLabel(place: Pick<Place, "genre" | "categories">): string {
  const words = (place.genre.replace("urn:tag:genre:place:", "").split(":").at(-1) ?? "").replaceAll("_", " ").trim();
  if (words) return words[0]!.toUpperCase() + words.slice(1);
  return place.categories[0] ?? "Place";
}
