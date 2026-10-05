export const capLine = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…`);

export const normalize = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
export const tokenize = (text) => normalize(text).split(/[^0-9a-z\u4e00-\u9fff]+/).filter((token) => token !== '');
export const uniqueText = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];
export const oneLineText = (text) => String(text).replace(/\s+/g, ' ').trim();
