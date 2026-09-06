import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateHistoricalValidation, alignBenchmarkCloses, buildHtml, collectBacktest, formatHistoricalConsole, forwardNetReturn, main, parseBacktestOptions, summarize } from '../src/backtest.js';
import { BENCHMARKS } from '../src/config.js';
import type { Candle } from '../src/data.js';
import type { HistoricalValidation } from '../src/forecast.js';

const fixture: Candle[] = [
  { date: new Date('2020-01-01'), open: 90, high: 110, low: 80, close: 100, volume: 1000 },
  { date: new Date('2020-01-02'), open: 125, high: 160, low: 120, close: 150, volume: 1000 },
  { date: new Date('2020-01-03'), open: 160, high: 260, low: 150, close: 250, volume: 1000 },
];

test('forward execution enters at next open and exits at t+h close with round-trip cost', () => {
  assert.ok(Math.abs(forwardNetReturn(fixture, 0, 1)! - 19.8) < 1e-10);
  assert.equal(forwardNetReturn(fixture, 0, 2), 99.8);
  assert.equal(forwardNetReturn(fixture, 0, 2, 0), 100);
  assert.equal(forwardNetReturn(fixture, 0, 2, 125), 98.75);
  assert.equal(forwardNetReturn(fixture, 1, 2), null);
});

test('forward returns preserve raw tails and reject unusable execution prices', () => {
  const tail = fixture.map(candle => ({ ...candle }));
  tail[2].close = 125000;
  assert.equal(forwardNetReturn(tail, 0, 2, 0), 99900);
  tail[1].open = 0;
  assert.equal(forwardNetReturn(tail, 0, 2), null);
  tail[1].open = NaN;
  assert.equal(forwardNetReturn(tail, 0, 2), null);
  assert.throws(() => forwardNetReturn(fixture, 0, 2, -1), /cost/i);
});

test('numeric options accept zero costs but require positive integer sampling parameters', () => {
  assert.deepEqual(parseBacktestOptions([]), { days: 250, step: 2, limit: 20, horizons: [5, 10, 20], costBps: 20 });
  assert.deepEqual(parseBacktestOptions(['--days=120', '--step=5', '--limit=3', '--horizons=1,5,5', '--cost-bps=0']),
    { days: 120, step: 5, limit: 3, horizons: [1, 5], costBps: 0 });
  assert.equal(parseBacktestOptions(['--cost-bps=2.5']).costBps, 2.5);
  for (const argument of ['--days=0', '--step=-2', '--limit=1.5', '--days=NaN', '--step=Infinity', '--days=', '--days', '--days=2=3', '--days=9007199254740992', '--horizons=5,,10', '--horizons=0,5', '--horizons=2.5', '--cost-bps=-1', '--cost-bps=Infinity', '--cost-bps=', '--unknown=2']) {
    assert.throws(() => parseBacktestOptions([argument]), /--/, argument);
  }
});

function validation(overrides: Partial<HistoricalValidation> = {}): HistoricalValidation {
  return { days: 5, tested: 10, estimated: 10, brier: 0.1, baselineBrier: 0.2, meanReturn: 2,
    selectedReturn: 8, selectedCount: 2,
    calibration: [{ band: '60-100%', count: 2, predicted: 0.8, observed: 1 }], ...overrides };
}

test('historical aggregation weights estimated rows, selected rows and calibration counts separately', () => {
  const [result] = aggregateHistoricalValidation([
    [validation()],
    [validation({ tested: 30, estimated: 30, brier: 0.3, baselineBrier: 0.4, meanReturn: -2, selectedReturn: -2, selectedCount: 8,
      calibration: [{ band: '60-100%', count: 8, predicted: 0.6, observed: 0.25 }] })],
    [validation({ tested: 40, estimated: 0, brier: null, baselineBrier: null, meanReturn: null, selectedReturn: null, selectedCount: 0,
      calibration: [{ band: '60-100%', count: 0, predicted: null, observed: null }] })],
    [],
  ]);
  assert.equal(result.tested, 80);
  assert.equal(result.estimated, 40);
  assert.equal(result.brier, 0.25);
  assert.equal(result.baselineBrier, 0.35);
  assert.equal(result.meanReturn, -1);
  assert.equal(result.selectedCount, 10);
  assert.equal(result.selectedReturn, 0);
  assert.equal(result.calibration[0].count, 10);
  assert.ok(Math.abs(result.calibration[0].predicted! - 0.64) < 1e-10);
  assert.equal(result.calibration[0].observed, 0.4);
});

test('missing forecast coverage stays null and horizons are not pooled together', () => {
  const results = aggregateHistoricalValidation([
    [validation({ days: 20, tested: 7, estimated: 0, brier: null, baselineBrier: null, meanReturn: null,
      selectedReturn: null, selectedCount: 0, calibration: [{ band: '0-40%', count: 0, predicted: null, observed: null }] })],
    [validation({ selectedCount: 0, selectedReturn: null })],
  ]);
  assert.deepEqual(results.map(result => result.days), [5, 20]);
  assert.equal(results[0].selectedReturn, null);
  assert.equal(results[1].tested, 7);
  assert.equal(results[1].estimated, 0);
  assert.equal(results[1].brier, null);
  assert.equal(results[1].meanReturn, null);
  assert.equal(results[1].calibration[0].predicted, null);
  assert.deepEqual(aggregateHistoricalValidation([]), []);
});

test('technical benchmark context uses exact dates without filling missing sessions or future values', () => {
  const benchmark = [fixture[2], fixture[0], fixture[1], { ...fixture[2], date: new Date('2020-01-04'), close: 9000 }];
  assert.deepEqual(alignBenchmarkCloses(fixture, benchmark, 2), [100, 150, 250]);
  assert.equal(alignBenchmarkCloses(fixture, [fixture[0], fixture[2]], 2), undefined);
  assert.deepEqual(alignBenchmarkCloses(fixture.slice(0, 2), benchmark, 1), [100, 150]);
});

test('technical summary retains extreme returns without mutating observations', () => {
  const observations = Array.from({ length: 100 }, (_, index) => ({ symbol: `TEST${index}`, name: 'Test',
    date: '2020-01-01', score: 70, recommendation: '\u05e7\u05e0\u05d9\u05d9\u05d4 \u05d7\u05d6\u05e7\u05d4' as const, signals: [], fwd: { 1: index === 99 ? 10000 : 0 } }));
  const summary = summarize(observations, [1]);
  assert.equal(summary.benchmark[1], 100);
  assert.equal(observations[99].fwd[1], 10000);
});

test('collection fetches benchmarks once, reuses fallback and requests at least 730 days', async () => {
  const history = Array.from({ length: 520 }, (_, index) => {
    const close = 100 + index / 20;
    return { date: new Date(Date.UTC(2020, 0, index + 1)), open: close * 0.995, high: close + 1,
      low: close - 1, close, volume: 10000 };
  });
  const requests: Array<{ symbol: string; days: number }> = [];
  const result = await collectBacktest(parseBacktestOptions(['--days=12', '--horizons=2', '--step=5', '--cost-bps=40']), {
    universe: [{ symbol: 'ONE.TA', name: 'One' }, { symbol: 'TWO', name: 'Two' }, { symbol: 'ONE.TA', name: 'Duplicate' }, { symbol: 'BAD', name: 'Bad' }],
    fetchCandles: async (symbol, days) => {
      requests.push({ symbol, days });
      if (symbol === 'BAD') throw new Error('Unavailable');
      return symbol === BENCHMARKS.israel.symbol ? [] : history;
    },
    log: () => {}, pause: async () => {},
  });
  assert.ok(requests.every(request => request.days === 730));
  assert.equal(requests.filter(request => request.symbol === BENCHMARKS.israel.symbol).length, 1);
  assert.equal(requests.filter(request => request.symbol === BENCHMARKS.israel.fallback).length, 1);
  assert.equal(requests.filter(request => request.symbol === BENCHMARKS.world.symbol).length, 1);
  assert.equal(requests.filter(request => request.symbol === 'ONE.TA').length, 1);
  assert.equal(result.historical.length, 3);
  assert.equal(result.historical[0].benchmark, BENCHMARKS.israel.fallback);
  assert.equal(result.historical[1].benchmark, BENCHMARKS.world.symbol);
  assert.equal(result.historical[2].error, 'Unavailable');
  assert.deepEqual(result.historical[2].validation, []);
  assert.deepEqual(result.historical[0].validation.map(row => [row.days, row.tested]), [[5, 2], [10, 2], [20, 1]]);
  assert.equal(result.observations.length, 6);
  const expected = (history[508].close / history[507].open - 1) * 100 - 0.4;
  assert.ok(Math.abs(result.observations[0].fwd[2]! - expected) < 1e-10);
});

test('console and HTML expose weighted metrics, missing coverage and escaped symbol errors', () => {
  const historical = [
    { symbol: 'ONE', name: 'One', candleCount: 520, benchmark: '^GSPC', error: null, validation: [validation()] },
    { symbol: 'TWO', name: 'Two', candleCount: 500, benchmark: null, error: null,
      validation: [validation({ tested: 30, estimated: 30, brier: 0.3, baselineBrier: 0.4, meanReturn: -2, selectedReturn: -2, selectedCount: 8,
        calibration: [{ band: '60-100%', count: 8, predicted: 0.6, observed: 0.25 }] })] },
    { symbol: 'BAD', name: '<script>bad</script>', candleCount: 0, benchmark: null, error: '<unavailable>', validation: [] },
  ];
  const text = formatHistoricalConsole(historical);
  assert.match(text, /estimated=40.*tested=40/);
  assert.match(text, /Brier=0\.2500.*baseline Brier=0\.3500/);
  assert.match(text, /ALL eligible=-1\.00%.*selected=\+0\.00%.*n=10/);
  assert.match(text, /60-100%.*n=10.*predicted=64\.0%.*actual=40\.0%/);
  assert.match(text, /ONE/);
  assert.match(text, /BAD.*<unavailable>/);
  const options = parseBacktestOptions([]);
  const html = buildHtml([], summarize([]), new Date('2026-09-06'), options, historical);
  assert.match(html, /0\.2500/);
  assert.match(html, /0\.3500/);
  assert.match(html, /64\.0%/);
  assert.match(html, /40\.0%/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.match(html, /&lt;unavailable&gt;/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('zero observations sets exit code 1 without writing a report or contacting the network', async () => {
  const oldExitCode = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await main([], { universe: [], fetchCandles: async () => [], log: () => {}, pause: async () => {} });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = oldExitCode;
    console.log = originalLog;
    console.error = originalError;
  }
});