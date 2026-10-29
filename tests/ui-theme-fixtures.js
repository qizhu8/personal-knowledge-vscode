const themes = {
  dark: { background:"#1e1e1e", foreground:"#cccccc", muted:"#9d9d9d", input:"#3c3c3c", secondary:"#3a3d41", secondaryForeground:"#ffffff", border:"#6b6b6b", success:"#89d185", error:"#f48771", focus:"#007fd4" },
  light: { background:"#ffffff", foreground:"#333333", muted:"#616161", input:"#ffffff", secondary:"#e5e5e5", secondaryForeground:"#333333", border:"#767676", success:"#287b24", error:"#a1260d", focus:"#005fb8" },
  "high-contrast": { background:"#000000", foreground:"#ffffff", muted:"#ffffff", input:"#000000", secondary:"#000000", secondaryForeground:"#ffffff", border:"#ffffff", success:"#89d185", error:"#f48771", focus:"#f38518" },
  "high-contrast-light": { background:"#ffffff", foreground:"#292929", muted:"#292929", input:"#ffffff", secondary:"#ffffff", secondaryForeground:"#292929", border:"#292929", success:"#287b24", error:"#a1260d", focus:"#0f4a85" },
};

async function applyTheme(page, name) {
  const theme = themes[name];
  if (!theme) throw new Error(`Unknown test theme: ${name}`);
  await page.evaluate(({ name, theme }) => {
    document.body.classList.remove("vscode-dark", "vscode-light", "vscode-high-contrast", "vscode-high-contrast-light");
    document.body.classList.add(`vscode-${name}`);
    const tokens = {
      "editor-background":theme.background, "sideBar-background":theme.background, foreground:theme.foreground,
      descriptionForeground:theme.muted, "editorWidget-background":theme.secondary,
      "input-background":theme.input, "input-foreground":theme.foreground, "input-border":theme.border,
      "dropdown-background":theme.input, "dropdown-foreground":theme.foreground, "dropdown-border":theme.border,
      "panel-border":theme.border, "button-secondaryBackground":theme.secondary, "button-secondaryForeground":theme.secondaryForeground,
      "button-background":theme.focus, "button-foreground":"#ffffff", "button-border":theme.border,
      "textCodeBlock-background":theme.secondary, "textLink-foreground":theme.focus, focusBorder:theme.focus,
      "testing-iconPassed":theme.success, errorForeground:theme.error, "gitDecoration-addedResourceForeground":theme.success,
      "gitDecoration-deletedResourceForeground":theme.error,
    };
    for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--vscode-${key}`, value);
    document.documentElement.style.setProperty("--vscode-font-family", "sans-serif");
    document.documentElement.style.setProperty("--vscode-font-size", "13px");
  }, { name, theme });
}

module.exports = { themes, applyTheme };
