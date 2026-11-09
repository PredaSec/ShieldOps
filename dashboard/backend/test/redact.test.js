'use strict';

const { redactString, redactObject } = require('../src/middleware/redact');

describe('redactString', () => {
  test('redacts AKIA access key ID', () => {
    const input  = 'Using key AKIAIOSFODNN7EXAMPLE for deployment';
    const output = redactString(input);
    expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(output).toContain('AKIA…****');
  });

  test('redacts ASIA session key', () => {
    const input  = 'key=ASIAIOSFODNN7EXAMPLE';
    const output = redactString(input);
    expect(output).not.toContain('ASIAIOSFODNN7EXAMPLE');
    expect(output).toContain('ASIA…****');
  });

  test('redacts AWS secret access key by field name', () => {
    const input  = 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const output = redactString(input);
    expect(output).not.toContain('wJalrXUtnFEMI');
    expect(output).toContain('**REDACTED**');
  });

  test('redacts SecretAccessKey field', () => {
    const input  = '"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
    const output = redactString(input);
    expect(output).not.toContain('wJalrXUtnFEMI');
  });

  test('returns non-string values unchanged', () => {
    expect(redactString(42)).toBe(42);
    expect(redactString(null)).toBeNull();
  });

  test('does not modify strings without credentials', () => {
    const clean = 'Deploy to us-east-1 succeeded.';
    expect(redactString(clean)).toBe(clean);
  });

  test('AKIA key partial preserve format: AKIA...****', () => {
    const out = redactString('AKIAIOSFODNN7EXAMPLE');
    expect(out).toMatch(/^AKIA…\*{4}$/);
  });
});

describe('redactObject', () => {
  test('redacts secretAccessKey in object', () => {
    const obj = { secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
    const out = redactObject(obj);
    expect(out.secretAccessKey).toBe('**REDACTED**');
    expect(out.region).toBe('us-east-1');
  });

  test('redacts password field', () => {
    const obj = { username: 'admin', password: 'supersecret' };
    const out = redactObject(obj);
    expect(out.password).toBe('**REDACTED**');
    expect(out.username).toBe('admin');
  });

  test('redacts nested credentials', () => {
    const obj = { aws: { secretAccessKey: 'abc123', region: 'eu-west-1' } };
    const out = redactObject(obj);
    expect(out.aws.secretAccessKey).toBe('**REDACTED**');
    expect(out.aws.region).toBe('eu-west-1');
  });

  test('handles arrays', () => {
    const arr = [{ token: 'mytoken' }, { value: 'safe' }];
    const out = redactObject(arr);
    expect(out[0].token).toBe('**REDACTED**');
    expect(out[1].value).toBe('safe');
  });

  test('handles primitives', () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
    expect(redactObject(null)).toBeNull();
  });

  test('does not mutate original object', () => {
    const orig = { secretAccessKey: 'secret123' };
    redactObject(orig);
    expect(orig.secretAccessKey).toBe('secret123');
  });
});
