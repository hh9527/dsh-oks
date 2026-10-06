export const capLine = (text: string, max: number): string =>
  (text.length <= max ? text : `${text.slice(0, max)}…`);

export const normalize = (text: unknown): string =>
  String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
export const tokenize = (text: unknown): string[] =>
  normalize(text).split(/[^0-9a-z\u4e00-\u9fff]+/).filter((token) => token !== '');
export const uniqueText = (values: readonly unknown[]): string[] => [
  ...new Set(values.filter((value): value is string => typeof value === 'string' && value !== '')),
];
export const oneLineText = (text: unknown): string => String(text).replace(/\s+/g, ' ').trim();
