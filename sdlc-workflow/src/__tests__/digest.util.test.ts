import { inputsDigest, stableStringify } from '../utils/digest';

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}'
    );
  });

  it('preserves array order', () => {
    expect(stableStringify([2, 1, { b: 1, a: 2 }])).toBe('[2,1,{"a":2,"b":1}]');
  });

  it('drops undefined values and handles primitives', () => {
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(5)).toBe('5');
    expect(stableStringify(null)).toBe('null');
  });
});

describe('inputsDigest', () => {
  it('is identical for logically equal values regardless of key order', () => {
    expect(inputsDigest({ a: 1, b: 2 })).toBe(inputsDigest({ b: 2, a: 1 }));
  });

  it('changes when any input changes', () => {
    expect(inputsDigest({ a: 1 })).not.toBe(inputsDigest({ a: 2 }));
  });

  it('produces a sha-256 hex string', () => {
    expect(inputsDigest('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
