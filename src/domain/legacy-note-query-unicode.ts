import { CoreError } from "../host-composition-legacy-batch15-errors.js";

// Derived against Python 3.11 Unicode 14 and Node's Unicode 17, including Final_Sigma context.
const casedDifference = [[661,661],[4348,4348],[7305,7306],[42955,42959],[42962,42962],[42964,42964],[42970,42972],[42993,42996],[43881,43881],[68944,68965],[68976,68997],[93856,93880],[93883,93907],[122661,122666],[122928,122989]];
const ignorableDifference = [[2199,2199],[3790,3790],[6863,6877],[6880,6891],[42993,42993],[68942,68942],[68969,68973],[68975,68975],[69317,69317],[69370,69375],[70209,70209],[70587,70592],[70606,70606],[70608,70608],[70610,70610],[70625,70626],[71454,71454],[72544,72544],[72546,72548],[72550,72550],[73177,73177],[73472,73473],[73526,73530],[73536,73536],[73538,73538],[73562,73562],[78905,78912],[78919,78933],[90398,90409],[90413,90415],[93504,93506],[93547,93548],[94194,94195],[122928,122989],[123023,123023],[124139,124143],[124398,124399],[124643,124643],[124646,124646],[124654,124655],[124661,124661],[124671,124671]];
const unchangedLower = [[7305,7305],[42955,42956],[42958,42958],[42962,42962],[42964,42964],[42970,42970],[42972,42972],[68944,68965],[93856,93880]];
const lowerExceptions = new RegExp(`[\\u03a3${unchangedLower.map(([first, last]) =>
  `\\u{${first!.toString(16)}}${first === last ? "" : `-\\u{${last!.toString(16)}}`}`).join("")}]`, "u");
const inRanges = (point: number, ranges: number[][]) => ranges.some(([first, last]) => point >= first! && point <= last!);
const pythonProperty = (char: string, property: RegExp, differences: number[][]) =>
  property.test(char) !== inRanges(char.codePointAt(0)!, differences);

export function assertLegacyNoteUnicode(): void {
  if (process.versions.unicode !== "17.0")
    throw new CoreError("NOT_AVAILABLE", "Legacy Note Unicode compatibility requires the qualified Unicode 17 runtime.");
}
export function pythonLower(value: string): string {
  assertLegacyNoteUnicode();
  if (!lowerExceptions.test(value)) return value.toLowerCase();
  return lowerWithExceptions(value);
}
function lowerWithExceptions(value: string): string {
  const chars = Array.from(value);
  return chars.map((char, index) => {
    if (inRanges(char.codePointAt(0)!, unchangedLower)) return char;
    if (char !== "\u03a3") return char.toLowerCase();
    let before = index - 1, after = index + 1;
    while (before >= 0 && pythonProperty(chars[before]!, /\p{Case_Ignorable}/u, ignorableDifference)) before--;
    while (after < chars.length && pythonProperty(chars[after]!, /\p{Case_Ignorable}/u, ignorableDifference)) after++;
    return before >= 0 && pythonProperty(chars[before]!, /\p{Cased}/u, casedDifference)
      && !(after < chars.length && pythonProperty(chars[after]!, /\p{Cased}/u, casedDifference)) ? "\u03c2" : "\u03c3";
  }).join("");
}
export function pythonStrip(value: string): string {
  return value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
}
