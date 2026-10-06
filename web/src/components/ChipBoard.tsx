import type { Dispatch } from "react";
import { type Action, confirmed, MIN_PICKS, type Person } from "../state.ts";
import type { Chip, ChipOption } from "../types.ts";

const typeLabel = (o: ChipOption) => (o.kind === "concept" ? "style" : o.type.replaceAll("_", " "));

function Stamp({ chip, onPick, onRemove }: { chip: Chip; onPick: (id: string) => void; onRemove: () => void }) {
  const remove = (label: string) => (
    <button type="button" className="stamp__x" aria-label={`Remove ${label}`} onClick={onRemove}>
      ×
    </button>
  );

  if (chip.status === "resolved" && chip.selected) {
    const o = chip.selected;
    const alternatives = chip.options.filter((alt) => alt.id !== o.id);
    return (
      <div className="stamp" data-kind={o.kind}>
        {o.image && <img className="stamp__img" src={o.image} alt="" loading="lazy" />}
        <div>
          <span className="stamp__type mono">{typeLabel(o)}</span>
          <strong className="stamp__name">{o.name}</strong>
          {alternatives.length > 0 && (
            <details className="stamp__alt">
              <summary className="mono">not it?</summary>
              {alternatives.map((alt) => (
                <button key={alt.id} type="button" className="stamp__option" onClick={() => onPick(alt.id)}>
                  {alt.name} · {typeLabel(alt)}
                </button>
              ))}
            </details>
          )}
        </div>
        {remove(o.name)}
      </div>
    );
  }

  if (chip.status === "ambiguous") {
    return (
      <fieldset className="stamp stamp--ask">
        <legend className="mono">Which “{chip.query}”?</legend>
        {chip.options.map((o) => (
          <button key={o.id} type="button" className="stamp__option" onClick={() => onPick(o.id)}>
            {o.name} · {typeLabel(o)}
          </button>
        ))}
        {remove(chip.query)}
      </fieldset>
    );
  }

  return (
    <div className="stamp stamp--void">
      <s>{chip.query}</s>
      <span className="mono">not in Qloo</span>
      {remove(chip.query)}
    </div>
  );
}

export function ChipBoard({ person, index, dispatch }: { person: Person; index: number; dispatch: Dispatch<Action> }) {
  if (person.chips.length === 0) return null;
  const count = confirmed(person).length;
  return (
    <section aria-label={`${person.label}'s taste stamps`}>
      <ul className="stamps__list">
        {person.chips.map((chip, i) => (
          <li key={`${chip.query}-${i}`}>
            <Stamp
              chip={chip}
              onPick={(optionId) => dispatch({ type: "pick", person: index, chip: i, optionId })}
              onRemove={() => dispatch({ type: "removeChip", person: index, chip: i })}
            />
          </li>
        ))}
      </ul>
      <p className="stamps__count mono">
        {count}/{MIN_PICKS} stamps {count >= MIN_PICKS ? "· ready to board" : "needed"}
      </p>
    </section>
  );
}
