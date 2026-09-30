/**
 * Row memo across consecutive renders. pi-tui re-segments every grapheme on each truncate, and pi-jar's
 * chrome and overlays repaint on every Pi render (each streamed token) with mostly the same rows, or one
 * changed row while typing or scrolling. Rows transformed by the previous render are reused while the
 * scope (width, painter sample) holds, so memory stays bounded by two renders' rows.
 */
export class RowCache {
  private previous = new Map<string, string>();
  private current = new Map<string, string>();
  private scope: string | undefined;

  /** Start a render. A different scope drops every cached row. */
  begin(scope: string): void {
    this.previous = scope === this.scope ? this.current : new Map();
    this.current = new Map();
    this.scope = scope;
  }

  /** `transform(row)` for this render; `transform` may depend only on the row and the scope. */
  get(row: string, transform: (row: string) => string): string {
    let value = this.current.get(row) ?? this.previous.get(row);
    if (value === undefined) value = transform(row);
    this.current.set(row, value);
    return value;
  }
}
