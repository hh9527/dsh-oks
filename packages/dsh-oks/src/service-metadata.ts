/** Read build information without compiling or instantiating the model. */
export function readBuildInformation(bytes: Uint8Array): Record<string, unknown> | null {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let cursor = 0;
  const take = (size: number): Uint8Array => {
    if (!Number.isSafeInteger(size) || size < 0 || cursor + size > bytes.length) throw new Error('Truncated Wasm metadata');
    const value = bytes.subarray(cursor, cursor + size); cursor += size; return value;
  };
  const word = (): number => {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = take(1)[0];
      if (index === 4 && (byte & 0xf0) !== 0) throw new Error('Invalid Wasm section length');
      value += (byte & 0x7f) * 2 ** (7 * index);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Invalid Wasm section length');
  };
  if (Array.from(take(8)).join(',') !== '0,97,115,109,1,0,0,0') throw new Error('Invalid Wasm header');
  const results = new Map<string, Record<string, unknown>>();
  while (cursor < bytes.length) {
    const id = take(1)[0];
    const section = take(word());
    if (id !== 0) continue;
    const end = cursor; const start = end - section.length; cursor = start;
    const nameLength = word();
    if (cursor + nameLength > end) throw new Error('Invalid Wasm custom section name');
    const name = decoder.decode(take(nameLength));
    if (name === 'telora.build.information' || name === 'telora.service.metadata') {
      if (results.has(name)) throw new Error(`Duplicate build information section: ${name}`);
      const data: unknown = JSON.parse(decoder.decode(bytes.subarray(cursor, end)));
      if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid build information');
      const envelope = data as Record<string, unknown>;
      if (envelope.version !== 1 || envelope.entries === null || typeof envelope.entries !== 'object' || Array.isArray(envelope.entries)) throw new Error('Unsupported build information contract');
      results.set(name, envelope.entries as Record<string, unknown>);
    }
    cursor = end;
  }
  const current = results.get('telora.build.information');
  const legacy = results.get('telora.service.metadata');
  if (current && legacy && Object.hasOwn(current, 'ontology.knowledge') && Object.hasOwn(legacy, 'ontology.knowledge')) {
    throw new Error('Conflicting ontology.knowledge in build information and Service metadata');
  }
  return current === undefined ? legacy ?? null : { ...legacy, ...current };
}
