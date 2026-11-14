import * as vscode from "vscode";
import { questionSchema, validateQuestionAnswer } from "./chat-questions";
import type { PortalInteraction, PortalInteractionAnswer } from "./portal-interaction";

export async function requestNativePortalInteraction(interaction: PortalInteraction,
  current: () => boolean): Promise<PortalInteractionAnswer | undefined> {
  const assertCurrent = () => {
    if (!current()) throw new Error("Portal changed during confirmation; no authorization was applied.");
  };
  assertCurrent();
  if (!interaction.form) {
    const selected = await vscode.window.showWarningMessage(interaction.title,
      { modal: true, detail: interaction.detail }, ...interaction.choices.map(choice => choice.label));
    assertCurrent();
    const choice = interaction.choices.find(item => item.label === selected);
    return choice ? { action: choice.value, fields: {} } : undefined;
  }
  const schema = questionSchema(interaction.form);
  const choice = await vscode.window.showQuickPick(interaction.choices.map(item => ({
    label: item.label, value: item.value,
  })), { title: interaction.title, placeHolder: interaction.detail, ignoreFocusOut: true });
  assertCurrent();
  if (!choice || choice.value === "cancel") return undefined;
  if (choice.value !== "submit") {
    const confirmed = await vscode.window.showWarningMessage(interaction.title,
      { modal: true, detail: interaction.detail }, choice.label);
    assertCurrent();
    return confirmed === choice.label ? { action: choice.value, fields: {} } : undefined;
  }
  while (true) {
    const fields: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(schema.properties)) {
      if (field.default !== undefined) fields[name] = field.default;
    }
    for (const [name, field] of Object.entries(schema.properties)) {
      const visibility = interaction.fieldVisibility?.[name];
      if (visibility && !visibility.values.includes(String(fields[visibility.field]))) continue;
      assertCurrent();
      const title = `${interaction.title} · ${field.title || name}`;
      if (field.type === "boolean" || field.enum) {
        const values = field.enum || [true, false];
        const selected = await vscode.window.showQuickPick(values.map(value => ({
          label: String(value), value, description: value === field.default ? "Default" : undefined,
        })), { title, placeHolder: field.description, ignoreFocusOut: true });
        if (!selected) { assertCurrent(); return undefined; }
        fields[name] = selected.value;
      } else if (field.type === "array") {
        if (!field.items?.enum) throw new Error("Native Portal selections require declared choices.");
        const selected = await vscode.window.showQuickPick(field.items.enum.map(value => ({
          label: value, picked: Array.isArray(field.default) && field.default.includes(value),
        })), { title, placeHolder: field.description, canPickMany: true, ignoreFocusOut: true });
        if (!selected) { assertCurrent(); return undefined; }
        fields[name] = selected.map(item => item.label);
      } else {
        const value = await vscode.window.showInputBox({
          title, prompt: field.description, ignoreFocusOut: true,
          password: interaction.secretFields?.includes(name),
          value: fields[name] === undefined ? "" : String(fields[name]),
        });
        if (value === undefined) { assertCurrent(); return undefined; }
        if (!value && !schema.required?.includes(name)) delete fields[name];
        else fields[name] = field.type === "number" || field.type === "integer" ? value.trim() ? Number(value) : NaN : value;
      }
      assertCurrent();
    }
    try {
      validateQuestionAnswer(schema, fields, 16000);
      await interaction.verify?.(fields);
    } catch (error) {
      assertCurrent();
      const retry = await vscode.window.showErrorMessage(error instanceof Error ? error.message : "Invalid Portal answer.", "Retry");
      assertCurrent();
      if (retry === "Retry") continue;
      return undefined;
    }
    assertCurrent();
    const confirmed = await vscode.window.showWarningMessage(interaction.title,
      { modal: true, detail: interaction.detail }, choice.label);
    assertCurrent();
    return confirmed === choice.label ? { action: choice.value, fields } : undefined;
  }
}
