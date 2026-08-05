import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import csharp from "highlight.js/lib/languages/csharp";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, csharp, javascript, json, markdown, python, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language);
}

export function renderMarkdown(markdown) {
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }) => {
    const language = lang && hljs.getLanguage(lang) ? lang : undefined;
    const highlighted = language ? hljs.highlight(text, { language }).value : escapeHtml(text);
    const cls = lang === "mermaid" ? "mermaid" : `hljs${language ? ` language-${language}` : ""}`;
    return `<pre><code class="${cls}">${highlighted}</code></pre>`;
  };
  return marked.parse(String(markdown || ""), { renderer, gfm: true, breaks: true });
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}