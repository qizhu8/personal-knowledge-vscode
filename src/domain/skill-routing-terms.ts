export function memoryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(words.flatMap(word => /[\u3400-\u9fff]/.test(word) ? [word, ...Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2))] : [word]).filter(word => word.length > 1))].slice(0, 80);
}

export function memoryMatchScore(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? term.length : 0), 0);
}
