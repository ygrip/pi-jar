export const popupTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
export function pickPopup(factory: Function, value: unknown): unknown {
  let result: unknown;
  const component = factory({ requestRender() {}, terminal: { rows: 24 } }, popupTheme, {}, (selected: unknown) => { result = selected; });
  component.render(120);
  if (value === undefined) component.handleInput("\x1b");
  else { component.handleInput(String(value)); component.render(120); component.handleInput("\r"); }
  return result;
}
