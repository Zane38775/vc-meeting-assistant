import type { Material, MaterialPage, MaterialTerm } from './types';

export function validatedMaterialTerms(pages: readonly MaterialPage[], candidates: unknown): MaterialTerm[] {
  if (!Array.isArray(candidates)) return [];
  const terms: MaterialTerm[] = [];
  const escape = (literal: string) => literal.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, 48)) {
    const { term, page, quote } = candidate ?? {};
    if (typeof term !== 'string' || term.length < 2 || term.length > 40 || !/^[A-Za-z]+(?:[ -][A-Za-z]+){0,3}$/.test(term)) continue;
    if (!Number.isInteger(page) || typeof quote !== 'string' || quote.length > 250) continue;
    const source = pages.find(source => source.page === page);
    if (!source || !source.text.includes(quote)) continue;
    const wholeTerm = new RegExp(`(?<![A-Za-z0-9_-])${term}(?![A-Za-z0-9_-])`, 'g');
    const cited = [...quote.matchAll(wholeTerm)].some(({ index }) => {
      const prefix = escape(quote.slice(0, index));
      const suffix = escape(quote.slice(index + term.length));
      return new RegExp(prefix + wholeTerm.source + suffix).test(source.text);
    });
    if (!cited) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({ term, page, quote });
    if (terms.length === 24) break;
  }
  return terms;
}

export function findQuotedMaterial(materials: Material[], page: number, quote: string): Material | undefined {
  if (!quote) return undefined;
  const matches = materials.filter(material => material.pages.some(candidate => candidate.page === page && candidate.text.includes(quote)));
  return matches.length === 1 ? matches[0] : undefined;
}

const functionWords = new Set('a an the of and or but as at by for from in into on onto with within to up down out off over under through per via is am are be been being was were do does did have has had can could may might must shall should will would i we you he she it they them our your their its my his her this that these those any all each some no not more most less than when then where which what who how about after before also so thank thanks'.split(' '));
const englishWords = /(?<![A-Za-z0-9_-])[A-Za-z]+(?:-[A-Za-z]+)*(?![A-Za-z0-9_-])/g;

export function repeatedMaterialTerms(pages: readonly MaterialPage[]): MaterialTerm[] {
  const candidates = new Map<string, { source: MaterialPage; start: number; end: number; count: number; atBoundary: boolean }>();
  // Use the same bounded page range as material analysis and keep exact source offsets.
  for (const source of pages.slice(0, 100)) {
    const words = [];
    for (const match of source.text.matchAll(englishWords)) {
      const end = match.index + match[0].length;
      if (end > 3000) break;
      const units = match[0].toLowerCase().split('-');
      words.push({ start: match.index, end, units: units.length, allowed: units.every(unit => !functionWords.has(unit)) });
    }
    for (let index = 0; index < words.length; index++) {
      const first = words[index];
      if (!first.allowed) continue;
      const before = words[index - 1];
      const startsSpan = !before?.allowed || before.end + 1 !== first.start || source.text[before.end] !== ' ';
      let units = first.units;
      for (let next = index + 1; next < words.length; next++) {
        const word = words[next], previous = words[next - 1];
        units += word.units;
        if (!word.allowed || units > 4 || word.end - first.start > 40 ||
          word.start !== previous.end + 1 || source.text[previous.end] !== ' ') break;
        const key = source.text.slice(first.start, word.end).toLowerCase();
        const after = words[next + 1];
        const atBoundary = startsSpan || !after?.allowed || word.end + 1 !== after.start || source.text[word.end] !== ' ';
        const existing = candidates.get(key);
        if (existing) {
          existing.count++;
          if (atBoundary) existing.atBoundary = true;
        } else candidates.set(key, { source, start: first.start, end: word.end, count: 1, atBoundary });
      }
    }
  }
  // Exclude phrases seen only inside larger spans, and redundant subphrases with
  // no additional occurrences of their own.
  const eligible = [...candidates].filter(([, candidate]) => candidate.count >= 3 && candidate.atBoundary);
  const subsumed = new Set<string>();
  for (const [phrase, candidate] of eligible) {
    const words = phrase.split(' ');
    for (let start = 0; start < words.length - 1; start++) {
      for (let end = start + 2; end <= words.length; end++) {
        const part = words.slice(start, end).join(' ');
        if (part !== phrase && candidates.get(part)?.count === candidate.count) subsumed.add(part);
      }
    }
  }
  const repeated = eligible.filter(([key]) => !subsumed.has(key)).map(([, candidate]) => candidate)
    .sort((first, second) => second.count - first.count).slice(0, 8);
  return validatedMaterialTerms(pages, repeated.map(({ source, start, end }) => ({
    term: source.text.slice(start, end),
    page: source.page,
    quote: source.text.slice(Math.max(0, start - 40), end + 40),
  })));
}
