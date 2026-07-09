// Browser bundle for syntax highlighting — bundled by esbuild into dist/webview/hljs.js
import hljs from "highlight.js/lib/core";
import csharp from "highlight.js/lib/languages/csharp";
import python from "highlight.js/lib/languages/python";
import powershell from "highlight.js/lib/languages/powershell";
import sql from "highlight.js/lib/languages/sql";

hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("python", python);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("sql", sql);

// Minimal grammar for Microsoft SCOPE (.script) — SQL-like DSL with C#/Python UDOs
hljs.registerLanguage("scope", function (hl) {
  const KEYWORDS = {
    keyword:
      "SELECT FROM WHERE GROUP BY HAVING ORDER ASC DESC DISTINCT TOP " +
      "EXTRACT OUTPUT PROCESS REDUCE COMBINE CROSS APPLY UNION ALL INNER LEFT RIGHT FULL OUTER JOIN ON " +
      "USING PRODUCE READONLY PARAMS REQUIRED PRESORT AS OVER PARTITION " +
      "IF ELSE DECLARE SET MODULE IMPORT EXPORT FUNCTION VIEW STREAMEXPANDER " +
      "SSTREAM WITH STREAMSET SAMPLE ANY EVERY ROWS RANGE AND OR NOT IN LIKE BETWEEN IS NULL",
    built_in:
      "int long double float string bool DateTime decimal byte short " +
      "COUNT SUM AVG MIN MAX FIRST LAST ARGMAX ARGMIN ANY_VALUE MAP ARRAY " +
      "DefaultTextExtractor DefaultTextOutputter Structured",
    literal: "true false null TRUE FALSE NULL",
  };
  return {
    name: "Scope",
    case_insensitive: true,
    keywords: KEYWORDS,
    contains: [
      hl.COMMENT("//", "$"),
      hl.COMMENT("/\\*", "\\*/"),
      hl.COMMENT("#", "$"), // #CS / #ENDCS / directives
      { className: "string", begin: '@?"', end: '"', contains: [{ begin: '""' }] },
      { className: "string", begin: "'", end: "'" },
      hl.C_NUMBER_MODE,
      // Rowset / variable references
      { className: "variable", begin: /@\w+/ },
      // C# embedded blocks marker
      { className: "meta", begin: /#(CS|ENDCS|PY|ENDPY|IF|ELSE|ENDIF|DECLARE|SET|IMPORT|USING)\b/ },
    ],
  };
});

// Expose on window for the webview
window.hljs = hljs;
