import test from 'node:test';
import assert from 'node:assert/strict';
import { capBytes, fullBudgetCells, mergeCaps, fmtOf, isLogName } from '../src/caps.ts';
import { DEFAULT_CAPS } from '../src/config.ts';

const MB = 1048576;

test('format from extension', () => {
  assert.equal(fmtOf('run.HPL'), 'HPL'); assert.equal(fmtOf('a.ld'), 'MoTeC'); assert.equal(fmtOf('b.dl'), 'Holley');
  assert.equal(fmtOf('c.csv'), 'CSV'); assert.equal(fmtOf('noext'), 'CSV');
  assert.ok(isLogName('x.hpl') && isLogName('x.CSV') && !isLogName('x.png'));
  assert.ok(isLogName('idle.msl') && isLogName('IDLE.MLG'), 'MegaSquirt / TunerStudio text logs');
});
test('free tier is one cap for every format and device', () => {
  for (const device of ['phone', 'tablet']) for (const fmt of ['CSV', 'HPL', 'MoTeC', 'Holley']) {
    assert.equal(capBytes({ pro: false, device, fmt }), DEFAULT_CAPS.free * MB);
  }
});
test('pro caps depend on device and format', () => {
  assert.equal(capBytes({ pro: true, device: 'phone', fmt: 'HPL' }), 25 * MB);
  assert.equal(capBytes({ pro: true, device: 'phone', fmt: 'CSV' }), 80 * MB);
  assert.equal(capBytes({ pro: true, device: 'tablet', fmt: 'CSV' }), 150 * MB);
  assert.equal(capBytes({ pro: true, device: 'tablet', fmt: 'MoTeC' }), 80 * MB);
});
test('full-resolution budget by device', () => {
  assert.equal(fullBudgetCells('phone'), 8_000_000);
  assert.equal(fullBudgetCells('tablet'), 20_000_000);
});
test('remote caps merge over defaults and ignore junk', () => {
  const c = mergeCaps({ free: 20, phone: { HPL: 30, CSV: 'x' }, tablet: null, fullCellsPhone: -1, extra: true });
  assert.equal(c.free, 20); assert.equal(c.phone.HPL, 30); assert.equal(c.phone.CSV, 80);
  assert.deepEqual(c.tablet, DEFAULT_CAPS.tablet); assert.equal(c.fullCellsPhone, DEFAULT_CAPS.fullCellsPhone);
  assert.deepEqual(mergeCaps(undefined), DEFAULT_CAPS);
  assert.equal(capBytes({ pro: true, device: 'phone', fmt: 'HPL', caps: c }), 30 * MB);
});
