export function renderTemplatePreview(body: string, values: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_match, index) => values[Number(index) - 1] ?? `{{${index}}}`);
}
