export interface ThemeStateReader {
  getThemeOverride(): string | null;
  getStyleOverride(): string | null;
}

export class ThemeState implements ThemeStateReader {
  private theme: string | null = null;
  private style: string | null = null;

  getThemeOverride(): string | null {
    return this.theme;
  }

  getStyleOverride(): string | null {
    return this.style;
  }

  setTheme(theme: string): void {
    this.theme = theme;
  }

  setStyle(style: string): void {
    this.style = style;
  }
}
