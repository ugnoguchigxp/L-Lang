export interface Settings {
  multiplier: number;
  threshold: number;
}

export interface Input {
  values: number[];
  settings: Settings;
}

export interface Output {
  total: number;
  selected: number[];
}
