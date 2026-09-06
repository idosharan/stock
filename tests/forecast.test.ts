import test from 'node:test';
import assert from 'node:assert/strict';
import * as forecast from '../src/forecast.js';

function candles(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.03 + Math.sin(index / 11) * 3;
    return { date: new Date(Date.UTC(2020, 0, index + 1)), open: close - 0.1, high: close + 1, low: close - 1, close, volume: 10000 + index % 7 * 100 };
  });
}

test('short histories abstain instead of inventing probabilities', () => {
  assert.equal(typeof forecast.historicalForecast, 'function');
  const result = forecast.historicalForecast({ symbol: 'TEST', candles: candles(35) });
  assert.ok(result.horizons.length > 0);
  assert.ok(result.horizons.every(horizon => horizon.probabilityUp === null && horizon.status === 'insufficient'));
});

test('future prices cannot change a forecast made at an earlier date', () => {
  const history = candles(900);
  const asOf = history[700].date;
  const original = forecast.historicalForecast({ symbol: 'TEST', candles: history, asOf });
  const mutated = history.map(candle => candle.date > asOf ? { ...candle, open: 9000, high: 10000, low: 8000, close: 9500 } : candle);
  assert.deepEqual(forecast.historicalForecast({ symbol: 'TEST', candles: mutated, asOf }), original);
  assert.ok(original.horizons.some(horizon => horizon.sampleCount > 0));
  for (const horizon of original.horizons) {
    const dates = horizon.analogDates.map(date => Date.parse(date));
    for (let index = 1; index < dates.length; index++) {
      assert.ok(Math.abs(dates[index] - dates[index - 1]) >= (horizon.days + 1) * 86400000);
    }
  }
});

test('round-trip costs reduce historical net returns', () => {
  const history = candles(900);
  const gross = forecast.historicalForecast({ symbol: 'TEST', candles: history, costBps: 0 });
  const net = forecast.historicalForecast({ symbol: 'TEST', candles: history, costBps: 40 });
  for (let index = 0; index < gross.horizons.length; index++) {
    const before = gross.horizons[index].medianReturn;
    const after = net.horizons[index].medianReturn;
    if (before !== null && after !== null) assert.ok(Math.abs(before - after - 0.4) < 1e-9);
  }
  assert.ok(gross.horizons.some(horizon => horizon.medianReturn !== null));
});

test('events require timezone-qualified publication timestamps', () => {
  assert.throws(() => forecast.validateEvents([{ id: 'bad', type: 'earnings', symbol: 'TEST', occurredAt: '2021-01-01', publishedAt: '2021-01-01', source: 'https://example.com/event' }]));
});

test('events published after the forecast date are excluded', () => {
  const history = candles(900);
  const asOf = history[700].date;
  const result = forecast.historicalForecast({ symbol: 'TEST', candles: history, asOf, events: [
    { id: 'future', type: 'earnings', symbol: 'TEST', occurredAt: history[200].date.toISOString(), publishedAt: history[800].date.toISOString(), source: 'https://example.com/event' },
  ] });
  assert.deepEqual(result.events, []);
});

test('validation uses next-open execution and charges costs without truncating losses', () => {
  const history = candles(900).map(candle => ({ ...candle, open: 110, high: 111, low: 99, close: 100 }));
  const result = forecast.validateHistoricalForecast({ symbol: 'TEST', candles: history, costBps: 20 }, 60);
  for (const horizon of result) {
    assert.ok(horizon.estimated > 0);
    assert.ok(Math.abs(horizon.meanReturn! - (-9.290909090909092)) < 1e-9);
    assert.equal(horizon.brier, 0);
    assert.equal(horizon.baselineBrier, 0);
    assert.equal(horizon.selectedCount, 0);
    assert.equal(horizon.selectedReturn, null);
  }
});

test('intraday updates cannot change a forecast restricted to completed UTC sessions', () => {
  const history = candles(900);
  const asOf = new Date(history[700].date.getTime() + 12 * 3600000);
  const original = forecast.historicalForecast({ symbol: 'TEST', candles: history, asOf });
  const changed = history.map((candle, index) => index === 700 ? { ...candle, high: 10000, close: 9000 } : candle);
  assert.deepEqual(forecast.historicalForecast({ symbol: 'TEST', candles: changed, asOf }), original);
  assert.equal(original.asOf, history[699].date.toISOString());
});

test('benchmark open-time offsets within the same session do not change validation', () => {
  const history = candles(900);
  const shiftedBenchmark = history.map(candle => ({ ...candle, date: new Date(candle.date.getTime() + 3600000) }));
  const aligned = forecast.validateHistoricalForecast({ symbol: 'TEST', candles: history, benchmark: history }, 60);
  const shifted = forecast.validateHistoricalForecast({ symbol: 'TEST', candles: history, benchmark: shiftedBenchmark }, 60);
  assert.deepEqual(shifted, aligned);
  assert.ok(aligned.some(horizon => horizon.estimated > 0));
});