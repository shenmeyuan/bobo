// Bounded lexical recall for English words and overlapping Chinese phrases.
// These are literal terms, not semantic search or inferred synonyms.
export function memoryQueryTerms(query) {
  const terms = new Set();
  const add = (term) => {
    if (terms.size < 80) terms.add(term);
  };
  const matches =
    String(query ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]{2,64}/gu) || [];
  for (const term of matches) {
    add(term);
    for (const phrase of term.match(/[\p{Script=Han}]{2,}/gu) || []) {
      const characters = Array.from(phrase);
      for (let i = 0; i < characters.length - 1 && terms.size < 80; i++)
        add(characters.slice(i, i + 2).join(""));
    }
    if (terms.size >= 80) break;
  }
  return [...terms];
}
